// Intake — apply step (spec 035 §F5). Executes a routed IntakePlan
// against the store: the only intake layer that mutates live memory. All
// mutation flows through the store methods (createMemory / updateMemory /
// archiveMemory) — never raw writes — so the markdown vault + git history stay
// authoritative.
//
// Routing was decided upstream (routeIntake): this maps decision × action
// to a concrete mutation. The no-clobber guard (preservesOriginal) gates the
// augment write; a store rejection (e.g. a protected target) is caught and
// returned as `rejected`, never thrown, so one bad item can't abort a batch.

import { redactSecrets } from "../grooming-redaction.js";
import type { InboxSubmissionHints } from "../store/corpus/inbox.js";
import { type SplitReplacement, splitMemory } from "../store/split-memory.js";
import { augmentBody, preservesOriginal } from "./edit.js";
import type { IntakePlan } from "./judge.js";

/** The minimal stored memory the apply layer reads (authoritative, from the store). */
export interface IntakeStoredMemory {
  title: string;
  body: string;
}

/** The store surface the apply layer needs — all mutation flows through these. */
export interface IntakeApplyStore {
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { memory: { id: string } };
  updateMemory: (id: string, patch?: Record<string, unknown>, agent_id?: string) => unknown;
  archiveMemory: (id: string, agent_id?: string) => unknown;
  getMemory: (id: string) => IntakeStoredMemory | null;
}

export interface ApplyIntakeDeps {
  store: IntakeApplyStore;
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
  /**
   * Force-proposal routing (ADR 0004). When true, this submission must terminate
   * as a PROPOSAL, never an auto-apply: a would-be auto-apply is routed to a
   * proposal and a would-be auto-archive is skipped (archive is not proposable).
   * A submission that sets it is deduped/merged yet always lands for review.
   */
  forceProposal?: boolean;
  /** Optional sink for a swallowed store error, so a real bug stays observable. */
  onError?: (error: unknown) => void;
}

export type IntakeOutcome =
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

export function applyIntakePlan(plan: IntakePlan, deps: ApplyIntakeDeps): IntakeOutcome {
  const { store, submissionText, actorId } = deps;
  const hints = deps.submissionHints;
  // A consolidated memory is owned by the submitter (so recall scopes it), falling
  // back to the system actor when the submission carried no agent hint.
  const owner = hints?.agentId ?? actorId;
  const scope = (base: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base, agent_id: owner };
    // Set project_key only when the hint carries it. NB: today the markdown store
    // collapses both `null` (explicit global) and absent to `project_key: null`, so
    // this distinction is currently inert — preserved for forward-compat (a future
    // store-level default project) rather than load-bearing.
    if (hints?.projectKey !== undefined) out.project_key = hints.projectKey;
    // applies_to is a caller-asserted targeting signal the judge can't re-derive
    // from text, so carry it onto the new memory (the judge never sets it).
    if (hints?.appliesTo !== undefined) out.applies_to = hints.appliesTo;
    return out;
  };
  // The model's rationale is untrusted (could carry a hallucinated secret) and is
  // persisted into the vault + git history — redact it, like the curator does.
  const note = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    curator_note: {
      source: "intake",
      rationale: redactSecrets(plan.judgment.rationale).redacted,
      ...extra,
    },
  });

  // File the raw SUBMISSION as a fresh doc (the shared body of the create_new /
  // propose / force-propose lanes). `proposedAction` set → a PROPOSED doc
  // (requires_approval → status proposed, awaiting review) carrying the judge's
  // intended action; null → an active create_new. The judgment's title/target are
  // intentionally dropped — a human (or a later pass) decides filing from the raw
  // submission, never a low-confidence/under-eval merge.
  const proposeSubmission = (proposedAction: string | null): IntakeOutcome => {
    const proposed = proposedAction !== null;
    const options = note(proposed ? { proposed_action: proposedAction } : {});
    if (proposed) options.requires_approval = true;
    const input = scope({ title: deriveTitle(submissionText), body: submissionText });
    if (hints?.tags) input.tags = hints.tags; // the raw submission's tags (no judge tags here)
    const { memory } = store.createMemory(input, options);
    return { kind: proposed ? "proposed" : "created_new", id: memory.id };
  };

  try {
    if (plan.decision === "skip") return { kind: "skipped" };

    // Force-propose (ADR 0004): when the submission itself demands review (the
    // `forceProposal` hint), NOTHING auto-applies regardless of the routed decision
    // or confidence. Both the auto_apply lane AND create_new (which would land an
    // ACTIVE doc) are re-routed to a PROPOSAL of the raw submission, EXCEPT a
    // would-be auto-ARCHIVE which is SKIPPED — archive (and noop) are not proposable
    // (the archive wrinkle). `split` is already always-proposed (below); the existing
    // `propose` decision already files for review (left unchanged). Defence-in-depth
    // like C4's split: even at confidence 1.0 a force-proposed op never auto-applies.
    if (
      deps.forceProposal === true &&
      (plan.decision === "auto_apply" || plan.decision === "create_new")
    ) {
      if (plan.judgment.action === "archive" || plan.judgment.action === "noop") {
        return { kind: "skipped" };
      }
      if (plan.judgment.action !== "split") {
        return proposeSubmission(plan.judgment.action);
      }
      // split falls through to its always-proposed handling below (it's tagged there).
    }

    // Split (spec 043 D-B) — ALWAYS a proposal, never auto-applied, regardless of
    // the routed decision or confidence. Intake lacks grooming's whole-slice
    // context, so a human approves every intake split. We spin the judge's focused
    // replacements out as PROPOSED docs (requires_approval) that supersede the
    // overloaded source candidate, and leave the source ACTIVE — the admin archives
    // it on accept. The shared `splitMemory` primitive (the same one grooming uses)
    // sequences the writes; omitting an archive actor is what keeps it propose-only.
    if (plan.judgment.action === "split") {
      const j = plan.judgment;
      // The split target MUST be an existing candidate (the honest guard for
      // intake's thinner context — no fabricated/navigated target).
      if (!store.getMemory(j.target_id))
        return { kind: "rejected", reason: "split target missing" };
      const replacements: SplitReplacement[] = j.replacements.map((r) => ({
        input: scope({ title: r.title, body: r.body, tags: r.tags }),
        options: {
          ...note({ proposed_action: "split", supersedes: [j.target_id] }),
          requires_approval: true,
        },
      }));
      // No archive actor → the source stays active (a PROPOSED split). The new
      // proposal ids are the replacements; the outcome carries the SOURCE id so the
      // decision log records the split's target candidate.
      splitMemory(store, { sourceId: j.target_id, replacements });
      return { kind: "proposed", id: j.target_id };
    }

    // Uncertain merge / mid-confidence change → never touch an existing doc. File
    // the SUBMISSION as a fresh doc — active for create_new, or proposed (awaiting
    // human review) for propose. requires_approval is the store's signal that lands
    // a proposed doc at status=proposed.
    if (plan.decision === "create_new" || plan.decision === "propose") {
      return proposeSubmission(plan.decision === "propose" ? plan.judgment.action : null);
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
        // routeIntake maps noop → skip; reaching here is a mis-route.
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
