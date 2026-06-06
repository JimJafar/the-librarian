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

import { type ApplyDecision, type ApplyPolicy, decideApply } from "./curator-apply-policy.js";
import { tagAddendumVersion, tagDryRun, underEvaluationRoute } from "./curator-force-propose.js";
import type { CuratorMemoryPatch, CuratorOperation } from "./curator-output.js";
import { redactSecrets } from "./curator-redaction.js";
import type { ValidatedOperation, ValidationContext } from "./curator-validate.js";
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
  getMemory: (id: string) => StoredMemory | null;
  recordCurationOperation: (input: RecordCurationOperationInput) => unknown;
}

export interface ApplyDeps {
  store: ApplyStore;
  runId: string;
  /** Curator actor id for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  policy: ApplyPolicy;
  /**
   * Under-evaluation force-propose (spec 044 D-3). When true, the grooming addendum
   * is being evaluated: NO op auto-applies — a would-be auto-apply is routed to a
   * PROPOSAL and a would-be auto-archive is SKIPPED (archive is not proposable).
   * Default false → byte-identical to before D3a (the regression guard).
   */
  underEvaluation?: boolean;
  /**
   * The addendum version (git hash) being evaluated; stamped onto every proposal
   * produced while `underEvaluation` (spec 044 D-3) so D3b can find the batch. Only
   * meaningful with `underEvaluation`; ignored otherwise.
   */
  addendumVersion?: string | null;
  /**
   * Grooming dry-run (spec 044 D-4). When true this run is a CANDIDATE-addendum dry-
   * run: it force-proposes exactly like `underEvaluation` (nothing auto-applies),
   * but tags each proposal `dry_run` (+ `dryRunCandidate`) instead of an
   * addendum_version, so the throwaway batch is distinguishable from a real run. The
   * candidate addendum reaches the prompt via `promptAddendum`; it is NEVER written
   * to the vault. `dryRun` implies force-propose; set it WITHOUT `underEvaluation`.
   */
  dryRun?: boolean;
  /** A label for the dry-run candidate (e.g. "candidate v2" / a hash); tags proposals. */
  dryRunCandidate?: string | null;
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
  /** Set while the grooming addendum is under_evaluation — tags every proposal. */
  addendumVersion?: string | null;
  /** Set for a grooming dry-run (spec 044 D-4) — tags every proposal `dry_run`. */
  dryRun?: boolean;
  /** The dry-run candidate label; tags proposals alongside `dry_run`. */
  dryRunCandidate?: string | null;
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
  // Force-propose is on while the addendum is under_evaluation (D3a) OR for a dry-run
  // (D4) — both routes mean "no op auto-applies". They tag proposals differently.
  const forceProp = deps.underEvaluation === true || deps.dryRun === true;
  const exec: ExecContext = {
    store: deps.store,
    runId: deps.runId,
    actorId: deps.actorId,
    owner,
    // Carried so proposals produced under_evaluation are tagged (no-op when accepted).
    ...(deps.underEvaluation ? { addendumVersion: deps.addendumVersion } : {}),
    // Carried so dry-run proposals are tagged distinctly (no addendum_version).
    ...(deps.dryRun ? { dryRun: true, dryRunCandidate: deps.dryRunCandidate } : {}),
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
    // Under-evaluation force-propose (spec 044 D-3): while the grooming addendum is
    // being evaluated, divert a would-be auto-apply to `propose` and a would-be
    // auto-ARCHIVE to `skip` (archive is not proposable — the wrinkle). `propose`/
    // `skip` pass through unchanged, so a protected-propose stays propose. When
    // accepted (the default), the route is the identity → byte-identical to before.
    const routed = decideApply(operation, outcome, deps.policy);
    const decision = forceProp ? forcePropose(routed, operation.type) : routed;
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

// Adapt the grooming ApplyDecision to the shared under-evaluation routing rule
// (spec 044 D-3). `auto_apply` is the only would-be apply; the shared rule diverts
// a pure-archive auto-apply to skip and everything else to propose (and never
// returns "apply" for an under-eval op). `propose`/`skip` pass through unchanged.
function forcePropose(decision: ApplyDecision, type: CuratorOperation["type"]): ApplyDecision {
  if (decision !== "auto_apply") return decision;
  const routed = underEvaluationRoute("apply", type === "archive");
  // routed is "propose" | "skip" for a would-be apply — both valid ApplyDecisions.
  return routed === "skip" ? "skip" : "propose";
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
    case "merge":
      // Auto-applied merge: spin up the merged replacement, then archive the
      // sources. The shared primitive owns the create-then-archive ordering (on a
      // partial failure the duplicate stays active rather than losing a source);
      // pass the actor so it archives the superseded sources (an apply, not a
      // propose). Sibling of the split case below (N→1 vs 1→N).
      return [
        mergeMemory(c.store, {
          replacement: buildCreateCall(c, op.replacement, op.source_memory_ids),
          sourceIds: op.source_memory_ids,
          archiveActorId: c.actorId,
        }),
      ];
    case "split":
      // Auto-applied split: spin the replacements out, then archive the source.
      // The shared primitive owns the create-then-archive ordering; pass the
      // actor so it archives the superseded source (an apply, not a propose).
      return splitMemory(c.store, {
        sourceId: op.source_memory_id,
        replacements: op.replacements.map((r) => buildCreateCall(c, r, [op.source_memory_id])),
        archiveActorId: c.actorId,
      });
    case "noop":
      // decideApply routes noop → skip; reaching here is a mis-route — fail loud.
      throw new Error("noop is not applicable");
  }
}

// Route a protected operation to a proposal. Returns the new proposal
// ids. Sources are NOT archived — the admin archives the superseded
// memory after accepting (§11.1). The `requiresApproval: true` flag
// makes `createMemory` land each row at `status=proposed` without the
// legacy category-based bridge.
function proposeOp(op: CuratorOperation, c: ExecContext): string[] {
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
    case "noop":
      // decideApply routes these to apply/skip, never propose — fail loud.
      throw new Error(`${op.type} is not proposable`);
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
  // this unset and land at the conservative defaults the classifier
  // will overwrite.
  const isProposal = options.requiresApproval === true;
  // Tag PROPOSALS produced while the grooming addendum is under_evaluation with the
  // version being evaluated (spec 044 D-3), so D3b finds the batch. Gated on
  // isProposal so an auto-applied write is never tagged (defence-in-depth — under
  // evaluation an op never auto-applies anyway). No-op when accepted / no version.
  if (isProposal) tagAddendumVersion(curatorNote, c.addendumVersion);
  // Tag PROPOSALS produced by a dry-run (spec 044 D-4) so the throwaway batch is
  // distinguishable from real proposals. Mutually exclusive with addendum_version:
  // a dry-run runs a CANDIDATE addendum, never a committed eval version. Gated on
  // isProposal (a dry-run never auto-applies anyway). No-op for a non-dry run.
  if (isProposal && c.dryRun) tagDryRun(curatorNote, c.dryRunCandidate);
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
