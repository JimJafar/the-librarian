// Curator apply execution (spec §11 + §11.1). Consumes the §10.5 validated
// operations, runs each through the ONE apply rule (rethink D13,
// curator-apply-policy.ts), and EXECUTES the verdict against the store — the
// only layer in the curator that mutates live memory.
//
// Invariants:
//   - All memory mutations go through store methods (createMemory / updateMemory /
//     archiveMemory / flagMemory) — never raw writes (the vault + git history
//     stay authoritative).
//   - `curator_note` provenance is set only via createMemory's trusted `options`
//     channel, never via patch (which can't carry it anyway).
//   - Ownership: every write is owned by the curator actor (slices are
//     project-key-only post-D8). The agent_id is passed explicitly, never taken
//     from the model.
//   - Auto-applied merges archive their superseded sources in the same
//     operation. Proposed ops NEVER mutate live sources here — they land as a
//     new proposal carrying curator_note.supersedes (or, for archive, a flag).
//   - Every operation (applied / proposed / skipped / failed) is recorded for the
//     admin audit with the unified function's verdict; the recorded rationale is
//     redacted as defence-in-depth.

import { decideApplication } from "./curator-apply-policy.js";
import type { GroomingMemoryPatch, GroomingOperation } from "./grooming-output.js";
import { redactSecrets } from "./grooming-redaction.js";
import type { ValidatedOperation, ValidationContext } from "./grooming-validate.js";
import type { RecordCurationOperationInput } from "./store/curation-store.js";
import { mergeMemory } from "./store/merge-memory.js";
import { type SplitReplacement, splitMemory } from "./store/split-memory.js";

// The authoritative stored memory used to reconstruct a protected-update proposal.
// Must come from the store (getMemory), NOT the evidence projection, which is
// redacted + truncated.
interface StoredMemory {
  title: string;
  body: string;
  // Section 4d.2 — legacy columns kept optional; new memories don't
  // populate them. The curator still reads them when present on
  // pre-cutover rows so it can route via the legacy bridge for
  // historical evidence.
  category?: string;
  visibility?: string;
  scope?: string;
  project_key?: string | null;
  priority: string;
  confidence: string;
  tags: string[];
  applies_to: string[];
}

// The store surface the apply layer needs (all mutation flows through these).
export interface ApplyStore {
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { memory: { id: string } };
  updateMemory: (id: string, patch?: Record<string, unknown>, agent_id?: string) => unknown;
  archiveMemory: (id: string, agent_id?: string) => unknown;
  // Archive proposals ride the flag-review queue (D13: archive never
  // auto-applies, and there is no replacement doc to file as a proposal).
  flagMemory: (id: string, reason: string, agent_id?: string) => unknown;
  getMemory: (id: string) => StoredMemory | null;
  recordCurationOperation: (input: RecordCurationOperationInput) => unknown;
}

export interface ApplyDeps {
  store: ApplyStore;
  runId: string;
  /** Curator actor id for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  /** The single curator.apply.confidence_threshold knob (D13; default 0.8). */
  confidenceThreshold: number;
  /** Optional sink for swallowed execution errors (keeps the audit row content-free). */
  onError?: (error: unknown, operation: GroomingOperation) => void;
}

export interface ApplySummary {
  applied: number;
  proposed: number;
  skipped: number;
  failed: number;
}

interface ExecContext {
  store: ApplyStore;
  runId: string;
  actorId: string;
  owner: string;
}

export function applyOperations(
  validated: ValidatedOperation[],
  context: ValidationContext,
  deps: ApplyDeps,
): ApplySummary {
  const exec: ExecContext = {
    store: deps.store,
    runId: deps.runId,
    actorId: deps.actorId,
    // Slices are project-key-only (rethink D8): the curator actor owns every write.
    owner: deps.actorId,
  };

  const summary: ApplySummary = { applied: 0, proposed: 0, skipped: 0, failed: 0 };
  for (const { operation, outcome } of validated) {
    if (outcome.decision === "reject") {
      // A rejected op may have been rejected FOR its content (e.g. secrets), so
      // its payload is not persisted — only the value-free reason.
      record(deps, operation, "skipped", outcome.reason, [], {});
      summary.skipped++;
      continue;
    }
    // Accepted ops passed the §10.5 content guards, so their payload is safe to record.
    const payload = operationPayload(operation);
    // The ONE apply rule (D13) — the recorded status below IS this verdict.
    const decision = decideApplication({
      operation: operation.type,
      confidence: operation.confidence,
      threshold: deps.confidenceThreshold,
      targetRequiresApproval: outcome.targetRequiresApproval,
    });
    if (decision === "skip") {
      record(deps, operation, "skipped", operation.rationale, [], payload);
      summary.skipped++;
      continue;
    }
    try {
      if (decision === "propose") {
        record(
          deps,
          operation,
          "proposed",
          operation.rationale,
          proposeOp(operation, exec),
          payload,
        );
        summary.proposed++;
      } else {
        record(deps, operation, "applied", operation.rationale, applyOp(operation, exec), payload);
        summary.applied++;
      }
    } catch (error) {
      // Never echo the thrown error (could carry store/content detail) into the
      // audit row; surface it to the optional out-of-band sink so a programming
      // bug stays observable.
      deps.onError?.(error, operation);
      record(deps, operation, "failed", operation.rationale, [], payload);
      summary.failed++;
    }
  }
  return summary;
}

// Auto-apply an operation the D13 rule cleared; returns the target memory ids.
// archive/split never reach here (they ALWAYS propose, by operation type).
function applyOp(op: GroomingOperation, c: ExecContext): string[] {
  switch (op.type) {
    case "create":
      return [createMemory(c, op.memory, []).id];
    case "update":
      c.store.updateMemory(op.source_memory_id, op.patch, c.actorId);
      return [op.source_memory_id];
    case "merge":
      // Auto-applied merge: spin up the merged replacement, then archive the
      // sources. The shared primitive owns the create-then-archive ordering (on a
      // partial failure the duplicate stays active rather than losing a source);
      // pass the actor so it archives the superseded sources (an apply, not a
      // propose).
      return [
        mergeMemory(c.store, {
          replacement: buildCreateCall(c, op.replacement, op.source_memory_ids),
          sourceIds: op.source_memory_ids,
          archiveActorId: c.actorId,
        }),
      ];
    case "archive":
    case "split":
    case "noop":
      // decideApplication routes these to propose/skip, never apply — fail loud.
      throw new Error(`${op.type} is never auto-applied`);
  }
}

// Route an operation to a proposal. Returns the new proposal ids (or, for an
// archive, the flagged source ids). Sources are NOT archived — the admin
// archives the superseded memory after accepting (§11.1). The
// `requiresApproval: true` flag makes `createMemory` land each row at
// `status=proposed` without the legacy category-based bridge.
function proposeOp(op: GroomingOperation, c: ExecContext): string[] {
  const opts = { requiresApproval: true };
  switch (op.type) {
    case "create":
      return [createMemory(c, op.memory, [], opts).id];
    case "merge":
      // Proposed merge: spin up the merged replacement at requires_approval (status
      // proposed) but leave the sources ACTIVE — the admin archives them after
      // accepting (§11.1). No actor → the primitive does not archive the sources.
      return [
        mergeMemory(c.store, {
          replacement: buildCreateCall(c, op.replacement, op.source_memory_ids, opts),
          sourceIds: op.source_memory_ids,
        }),
      ];
    case "split":
      // Proposed split: spin the replacements out at requires_approval (status
      // proposed) but leave the source ACTIVE — the admin archives it after
      // accepting (§11.1). No actor → the primitive does not archive the source.
      return splitMemory(c.store, {
        sourceId: op.source_memory_id,
        replacements: op.replacements.map((r) =>
          buildCreateCall(c, r, [op.source_memory_id], opts),
        ),
      });
    case "update": {
      // Reconstruct from the AUTHORITATIVE store record (not the redacted/truncated
      // evidence), so a patch that omits a field proposes the real existing value.
      const existing = c.store.getMemory(op.source_memory_id);
      if (!existing) throw new Error("update source missing from store");
      return [createMemory(c, correctedMemory(existing, op.patch), [op.source_memory_id], opts).id];
    }
    case "archive":
      // A proposed archive has no replacement doc to file, so it rides the
      // flag-review queue (D13 / D4: the flag queue IS the human checkpoint):
      // each source is flagged (soft-demoted + routed to review) with the
      // redacted rationale, and the admin archives it on acceptance. Live
      // sources are never mutated here.
      for (const id of op.source_memory_ids) {
        c.store.flagMemory(
          id,
          `curator proposes archive: ${redactSecrets(op.rationale).redacted}`,
          c.actorId,
        );
      }
      return op.source_memory_ids;
    case "noop":
      // decideApplication routes noop → skip, never propose — fail loud.
      throw new Error("noop is not proposable");
  }
}

// Build the createMemory `{ input, options }` for one memory the curator writes
// (a create, a merge replacement, or a split replacement) WITHOUT executing it —
// so the split primitive can sequence the writes. Owner + curator_note (run_id +
// supersedes) + the optional requires_approval gate are baked in here.
function buildCreateCall(
  c: ExecContext,
  memory: Record<string, unknown>,
  supersedes: string[],
  options: { requiresApproval?: boolean } = {},
): SplitReplacement {
  const curatorNote: Record<string, unknown> = { run_id: c.runId };
  if (supersedes.length > 0) curatorNote.supersedes = supersedes;
  // Section 4d.3 — the curator emits requires_approval=true on
  // protected creates so the store can drop the legacy
  // category-based gate. Auto-apply paths (non-protected ops) leave
  // this unset and land at the conservative defaults
  // (requires_approval=false, is_global=false).
  const isProposal = options.requiresApproval === true;
  const storeOptions: Record<string, unknown> = { curator_note: curatorNote };
  if (isProposal) storeOptions.requires_approval = true;
  return { input: { ...memory, agent_id: c.owner }, options: storeOptions };
}

function createMemory(
  c: ExecContext,
  memory: Record<string, unknown>,
  supersedes: string[],
  options: { requiresApproval?: boolean } = {},
): { id: string } {
  const call = buildCreateCall(c, memory, supersedes, options);
  return c.store.createMemory(call.input, call.options).memory;
}

// Reconstruct the corrected memory for a protected update proposal: the patch
// merged over the AUTHORITATIVE stored memory. Every non-boundary field falls
// back to the existing value so an omitted patch field is preserved, not dropped.
// visibility is boundary-immutable (validation rejects a patch that changes it).
function correctedMemory(
  existing: StoredMemory,
  patch: GroomingMemoryPatch,
): Record<string, unknown> {
  return {
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    category: patch.category ?? existing.category,
    visibility: existing.visibility,
    scope: patch.scope ?? existing.scope,
    project_key: existing.project_key ?? undefined,
    applies_to: patch.applies_to ?? existing.applies_to,
    priority: patch.priority ?? existing.priority,
    confidence: patch.confidence ?? existing.confidence,
    tags: patch.tags ?? existing.tags,
  };
}

function record(
  deps: ApplyDeps,
  op: GroomingOperation,
  status: RecordCurationOperationInput["status"],
  rationale: string,
  targets: string[],
  proposedPayload: Record<string, unknown>,
): void {
  deps.store.recordCurationOperation({
    run_id: deps.runId,
    operation_type: op.type,
    status,
    confidence: op.confidence,
    rationale: redactSecrets(rationale).redacted,
    proposed_payload: proposedPayload,
    source_memory_ids: sourceMemoryIds(op),
    target_memory_ids: targets,
  });
}

// The operation's content for the audit record — EXCLUDES the raw rationale
// (recorded separately, redacted) since an accepted op's rationale prose could
// still carry a model-hallucinated secret; the content fields here passed the
// §10.5 secret guard.
function operationPayload(op: GroomingOperation): Record<string, unknown> {
  switch (op.type) {
    case "noop":
      return { source_memory_ids: op.source_memory_ids };
    case "archive":
      return { source_memory_ids: op.source_memory_ids };
    case "update":
      return { source_memory_id: op.source_memory_id, patch: op.patch };
    case "merge":
      return { source_memory_ids: op.source_memory_ids, replacement: op.replacement };
    case "split":
      return { source_memory_id: op.source_memory_id, replacements: op.replacements };
    case "create":
      return { memory: op.memory };
  }
}

function sourceMemoryIds(op: GroomingOperation): string[] {
  switch (op.type) {
    case "noop":
    case "archive":
    case "merge":
      return op.source_memory_ids;
    case "update":
    case "split":
      return [op.source_memory_id];
    case "create":
      return [];
  }
}
