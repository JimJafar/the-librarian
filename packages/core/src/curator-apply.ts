// Curator apply execution (spec §11 + §11.1). Consumes the §10.5 validated
// operations, runs each through the §11 decision policy, and EXECUTES the result
// against the store — the only layer in the curator that mutates live memory.
//
// Invariants:
//   - All memory mutations go through store methods (createMemory / updateMemory /
//     archiveMemory) — NEVER raw SQL (the projection is rebuilt from the ledger).
//   - `curator_note` provenance is set only via createMemory's trusted `options`
//     channel, never via patch (which can't carry it anyway).
//   - Ownership: agent_private writes are owned by the slice's agent; common
//     writes by the curator actor. The agent_id is passed explicitly, never taken
//     from the model.
//   - Non-protected merge/split archive their superseded sources in the same
//     operation. Protected ops are NEVER mutated here — they were routed to
//     "propose" (a new proposal carrying curator_note.supersedes) or "skip".
//   - Every operation (applied / proposed / skipped / failed) is recorded for the
//     admin audit; the recorded rationale is redacted as defence-in-depth.

import { type ApplyPolicy, decideApply } from "./curator-apply-policy.js";
import type { CuratorMemoryPatch, CuratorOperation } from "./curator-output.js";
import { redactSecrets } from "./curator-redaction.js";
import type { ValidatedOperation, ValidationContext } from "./curator-validate.js";
import type { RecordCurationOperationInput } from "./store/curation-store.js";

// The authoritative stored memory used to reconstruct a protected-update proposal.
// Must come from the store (getMemory), NOT the evidence projection, which is
// redacted + truncated.
interface StoredMemory {
  title: string;
  body: string;
  category: string;
  visibility: string;
  scope: string;
  project_key: string | null;
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
  getMemory: (id: string) => StoredMemory | null;
  recordCurationOperation: (input: RecordCurationOperationInput) => unknown;
}

export interface ApplyDeps {
  store: ApplyStore;
  runId: string;
  /** Curator actor id for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  policy: ApplyPolicy;
  /** Optional sink for swallowed execution errors (keeps the audit row content-free). */
  onError?: (error: unknown, operation: CuratorOperation) => void;
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
  const owner =
    context.slice.kind === "agent_private" && context.slice.agentId
      ? context.slice.agentId
      : deps.actorId;
  const exec: ExecContext = {
    store: deps.store,
    runId: deps.runId,
    actorId: deps.actorId,
    owner,
  };

  const summary: ApplySummary = { applied: 0, proposed: 0, skipped: 0, failed: 0 };
  for (const { operation, outcome } of validated) {
    if (outcome.decision === "reject") {
      // A rejected op may have been rejected FOR its content (e.g. secrets), so
      // its payload is not persisted — only the value-free reason.
      record(deps, operation, "skipped", "normal", outcome.reason, [], {});
      summary.skipped++;
      continue;
    }
    // Accepted ops passed the §10.5 content guards, so their payload is safe to record.
    const payload = operationPayload(operation);
    const decision = decideApply(operation, outcome, deps.policy);
    if (decision === "skip") {
      record(deps, operation, "skipped", outcome.risk, operation.rationale, [], payload);
      summary.skipped++;
      continue;
    }
    try {
      if (decision === "propose") {
        record(
          deps,
          operation,
          "proposed",
          outcome.risk,
          operation.rationale,
          proposeOp(operation, exec),
          payload,
        );
        summary.proposed++;
      } else {
        record(
          deps,
          operation,
          "applied",
          outcome.risk,
          operation.rationale,
          applyOp(operation, exec),
          payload,
        );
        summary.applied++;
      }
    } catch (error) {
      // Never echo the thrown error (could carry store/content detail) into the
      // audit row; surface it to the optional out-of-band sink so a programming
      // bug stays observable.
      deps.onError?.(error, operation);
      record(deps, operation, "failed", outcome.risk, operation.rationale, [], payload);
      summary.failed++;
    }
  }
  return summary;
}

// Auto-apply a non-protected operation; returns the target memory ids.
function applyOp(op: CuratorOperation, c: ExecContext): string[] {
  switch (op.type) {
    case "archive":
      for (const id of op.source_memory_ids) c.store.archiveMemory(id, c.actorId);
      return op.source_memory_ids;
    case "create":
      return [createMemory(c, op.memory, []).id];
    case "update":
      c.store.updateMemory(op.source_memory_id, op.patch, c.actorId);
      return [op.source_memory_id];
    case "merge": {
      // Create-then-archive: on partial failure the duplicate stays active
      // (recoverable next run) rather than losing the source (data loss).
      const target = createMemory(c, op.replacement, op.source_memory_ids).id;
      for (const id of op.source_memory_ids) c.store.archiveMemory(id, c.actorId);
      return [target];
    }
    case "split": {
      const targets = op.replacements.map((r) => createMemory(c, r, [op.source_memory_id]).id);
      c.store.archiveMemory(op.source_memory_id, c.actorId);
      return targets;
    }
    case "noop":
      // decideApply routes noop → skip; reaching here is a mis-route — fail loud.
      throw new Error("noop is not applicable");
  }
}

// Route a protected operation to a proposal (createMemory auto-routes a protected
// category to `proposed`); returns the new proposal ids. Sources are NOT archived
// — the admin archives the superseded memory after accepting (§11.1).
function proposeOp(op: CuratorOperation, c: ExecContext): string[] {
  switch (op.type) {
    case "create":
      return [createMemory(c, op.memory, []).id];
    case "merge":
      return [createMemory(c, op.replacement, op.source_memory_ids).id];
    case "split":
      return op.replacements.map((r) => createMemory(c, r, [op.source_memory_id]).id);
    case "update": {
      // Reconstruct from the AUTHORITATIVE store record (not the redacted/truncated
      // evidence), so a patch that omits a field proposes the real existing value.
      const existing = c.store.getMemory(op.source_memory_id);
      if (!existing) throw new Error("update source missing from store");
      return [createMemory(c, correctedMemory(existing, op.patch), [op.source_memory_id]).id];
    }
    case "archive":
    case "noop":
      // decideApply routes these to apply/skip, never propose — fail loud.
      throw new Error(`${op.type} is not proposable`);
  }
}

function createMemory(
  c: ExecContext,
  memory: Record<string, unknown>,
  supersedes: string[],
): { id: string } {
  const curatorNote: Record<string, unknown> = { run_id: c.runId };
  if (supersedes.length > 0) curatorNote.supersedes = supersedes;
  return c.store.createMemory({ ...memory, agent_id: c.owner }, { curator_note: curatorNote })
    .memory;
}

// Reconstruct the corrected memory for a protected update proposal: the patch
// merged over the AUTHORITATIVE stored memory. Every non-boundary field falls
// back to the existing value so an omitted patch field is preserved, not dropped.
// visibility is boundary-immutable (validation rejects a patch that changes it).
function correctedMemory(
  existing: StoredMemory,
  patch: CuratorMemoryPatch,
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
  op: CuratorOperation,
  status: RecordCurationOperationInput["status"],
  risk: string,
  rationale: string,
  targets: string[],
  proposedPayload: Record<string, unknown>,
): void {
  deps.store.recordCurationOperation({
    run_id: deps.runId,
    operation_type: op.type,
    status,
    confidence: op.confidence,
    risk_level: risk,
    rationale: redactSecrets(rationale).redacted,
    proposed_payload: proposedPayload,
    source_memory_ids: sourceMemoryIds(op),
    source_session_ids: sourceSessionIds(op),
    target_memory_ids: targets,
  });
}

// The operation's content for the audit record — EXCLUDES the raw rationale
// (recorded separately, redacted) since an accepted op's rationale prose could
// still carry a model-hallucinated secret; the content fields here passed the
// §10.5 secret guard.
function operationPayload(op: CuratorOperation): Record<string, unknown> {
  switch (op.type) {
    case "noop":
      return { source_memory_ids: op.source_memory_ids };
    case "archive":
      return {
        source_memory_ids: op.source_memory_ids,
        source_session_ids: op.source_session_ids ?? [],
      };
    case "update":
      return { source_memory_id: op.source_memory_id, patch: op.patch };
    case "merge":
      return { source_memory_ids: op.source_memory_ids, replacement: op.replacement };
    case "split":
      return { source_memory_id: op.source_memory_id, replacements: op.replacements };
    case "create":
      return { source_session_ids: op.source_session_ids, memory: op.memory };
  }
}

function sourceMemoryIds(op: CuratorOperation): string[] {
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

function sourceSessionIds(op: CuratorOperation): string[] {
  if (op.type === "create") return op.source_session_ids;
  if (op.type === "archive") return op.source_session_ids ?? [];
  return [];
}
