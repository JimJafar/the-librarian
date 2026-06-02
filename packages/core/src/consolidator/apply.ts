// Consolidator — apply step (spec 035 §F5). Executes a routed ConsolidationPlan
// against the store: the only consolidator layer that mutates live memory. All
// mutation flows through the store methods (createMemory / updateMemory /
// archiveMemory) — never raw writes — so the markdown vault + git history stay
// authoritative.
//
// Routing was decided upstream (routeConsolidation): this maps decision × action
// to a concrete mutation. The no-clobber guard (preservesOriginal) gates the
// augment write; a store rejection (e.g. a protected target) is caught and
// returned as `rejected`, never thrown, so one bad item can't abort a batch.

import { redactSecrets } from "../curator-redaction.js";
import type { InboxSubmissionHints } from "../store/corpus/inbox.js";
import { augmentBody, preservesOriginal } from "./edit.js";
import type { ConsolidationPlan } from "./judge.js";

/** The minimal stored memory the apply layer reads (authoritative, from the store). */
export interface ConsolidatorStoredMemory {
  title: string;
  body: string;
}

/** The store surface the apply layer needs — all mutation flows through these. */
export interface ConsolidatorApplyStore {
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { memory: { id: string } };
  updateMemory: (id: string, patch?: Record<string, unknown>, agent_id?: string) => unknown;
  archiveMemory: (id: string, agent_id?: string) => unknown;
  getMemory: (id: string) => ConsolidatorStoredMemory | null;
}

export interface ApplyConsolidationDeps {
  store: ConsolidatorApplyStore;
  /** The raw submission text — the doc source for create_new + propose. */
  submissionText: string;
  /** Actor id that owns a consolidated memory when the submission carries no agent hint. */
  actorId: string;
  /**
   * The original submission's filing/ownership hints. NEW memories (create /
   * create_new / propose) inherit the submitter's agent_id + project_key so a
   * consolidated memory keeps its scope; existing-doc edits (augment / supersede
   * / archive) keep the target's own scope and ignore these.
   */
  submissionHints?: InboxSubmissionHints;
  /** Optional sink for a swallowed store error, so a real bug stays observable. */
  onError?: (error: unknown) => void;
}

export type ConsolidationOutcome =
  | { kind: "created"; id: string }
  | { kind: "augmented"; id: string }
  | { kind: "superseded"; id: string }
  | { kind: "archived"; id: string }
  | { kind: "proposed"; id: string }
  | { kind: "created_new"; id: string }
  | { kind: "skipped" }
  | { kind: "rejected"; reason: string };

const MAX_TITLE = 80;

/** Derive a doc title from a submission: its first non-empty line, truncated. */
function deriveTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "Untitled note";
  return firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE - 1)}…` : firstLine;
}

export function applyConsolidationPlan(
  plan: ConsolidationPlan,
  deps: ApplyConsolidationDeps,
): ConsolidationOutcome {
  const { store, submissionText, actorId } = deps;
  const hints = deps.submissionHints;
  // A consolidated memory is owned by the submitter (so recall scopes it), falling
  // back to the system actor when the submission carried no agent hint.
  const owner = hints?.agentId ?? actorId;
  const scope = (base: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base, agent_id: owner };
    if (hints?.projectKey !== undefined) out.project_key = hints.projectKey;
    return out;
  };
  // The model's rationale is untrusted (could carry a hallucinated secret) and is
  // persisted into the vault + git history — redact it, like the curator does.
  const note = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    curator_note: {
      source: "consolidator",
      rationale: redactSecrets(plan.judgment.rationale).redacted,
      ...extra,
    },
  });

  try {
    if (plan.decision === "skip") return { kind: "skipped" };

    // Uncertain merge / mid-confidence change → never touch an existing doc. File
    // the SUBMISSION as a fresh doc — active for create_new, or requires_approval
    // (→ status proposed, awaiting human review) for propose. The judgment's
    // addition/title/target are intentionally dropped on this branch: a human (or
    // a later pass) decides filing from the raw submission, never a low-confidence
    // merge. requires_approval is the store's signal that lands it at status=proposed.
    if (plan.decision === "create_new" || plan.decision === "propose") {
      const proposed = plan.decision === "propose";
      const options = note(proposed ? { proposed_action: plan.judgment.action } : {});
      if (proposed) options.requires_approval = true;
      const input = scope({ title: deriveTitle(submissionText), body: submissionText });
      if (hints?.tags) input.tags = hints.tags; // the raw submission's tags (no judge tags here)
      const { memory } = store.createMemory(input, options);
      return { kind: proposed ? "proposed" : "created_new", id: memory.id };
    }

    // auto_apply — execute the judged action directly.
    const j = plan.judgment;
    switch (j.action) {
      case "create": {
        // The judge curated title/body/tags; the submitter's scope still applies.
        const { memory } = store.createMemory(
          scope({ title: j.title, body: j.body, tags: j.tags }),
          note(),
        );
        return { kind: "created", id: memory.id };
      }
      case "augment": {
        const existing = store.getMemory(j.target_id);
        if (!existing) return { kind: "rejected", reason: "augment target missing" };
        const body = augmentBody(existing.body, j.addition);
        // No-clobber guard (G5): augmentBody preserves by construction, but verify
        // before writing so a future non-append edit can't slip a clobber through.
        if (!preservesOriginal(existing.body, body)) {
          return { kind: "rejected", reason: "augment would clobber existing content" };
        }
        store.updateMemory(j.target_id, { body }, actorId);
        return { kind: "augmented", id: j.target_id };
      }
      case "supersede": {
        const existing = store.getMemory(j.target_id);
        if (!existing) return { kind: "rejected", reason: "supersede target missing" };
        // A deliberate replacement (git history holds the prior content); no-clobber
        // does not apply — the submission contradicts/updates the target.
        store.updateMemory(j.target_id, { title: j.title, body: j.body }, actorId);
        return { kind: "superseded", id: j.target_id };
      }
      case "archive": {
        if (!store.getMemory(j.target_id))
          return { kind: "rejected", reason: "archive target missing" };
        store.archiveMemory(j.target_id, actorId);
        return { kind: "archived", id: j.target_id };
      }
      case "noop":
        // routeConsolidation maps noop → skip; reaching here is a mis-route.
        return { kind: "skipped" };
    }
  } catch (error) {
    // A store rejection (e.g. updating a protected memory) must not abort the
    // batch — surface it as a value-free rejection. The optional sink keeps a
    // genuine programming bug observable rather than silently flattened.
    deps.onError?.(error);
    return { kind: "rejected", reason: error instanceof Error ? error.message : "store error" };
  }
}
