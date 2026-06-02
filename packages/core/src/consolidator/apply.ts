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
  /** Actor id that owns the created/updated memories (e.g. "system-consolidator"). */
  actorId: string;
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
  const note = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    curator_note: { source: "consolidator", rationale: plan.judgment.rationale, ...extra },
  });

  try {
    if (plan.decision === "skip") return { kind: "skipped" };

    // Uncertain merge / mid-confidence change → don't touch existing docs. File
    // the submission as a new doc (create_new, active) or a proposal (propose,
    // requires_approval) for human review; the target is left untouched.
    if (plan.decision === "create_new" || plan.decision === "propose") {
      const proposed = plan.decision === "propose";
      const { memory } = store.createMemory(
        { title: deriveTitle(submissionText), body: submissionText, agent_id: actorId },
        note(proposed ? { proposed_action: plan.judgment.action } : {}),
      );
      return { kind: proposed ? "proposed" : "created_new", id: memory.id };
    }

    // auto_apply — execute the judged action directly.
    const j = plan.judgment;
    switch (j.action) {
      case "create": {
        const { memory } = store.createMemory(
          { title: j.title, body: j.body, tags: j.tags, agent_id: actorId },
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
    // batch — surface it as a value-free rejection.
    return { kind: "rejected", reason: error instanceof Error ? error.message : "store error" };
  }
}
