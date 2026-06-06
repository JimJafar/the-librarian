// Consolidation (intake) decision-log store — shared type contract (spec 043 C1).
//
// The intake pipeline's full-outcome decision log, mirroring grooming's
// `CurationStore` run/operation shape (`curation-types.ts`) but for the
// consolidator sweep. It is a purely observational sidecar: it records what the
// intake judge decided + how each plan was applied (applied | proposed | skipped
// | failed) and NEVER influences filing. The concrete JSON-sidecar implementation
// lives in `sidecar/consolidation-store.ts`; the contract is re-exported from
// `consolidation-store.ts` to match the curation-store layering.
//
// Unlike grooming, intake has no slice/evidence/scheduler seam (one submission at
// a time, not a batched curation pass), so this store is deliberately the minimal
// run + operation subset of `CurationStore` — no `gatherMemoryEvidence` /
// `selectDueSlices` / `findRunningRun`.

export interface CreateConsolidationRunInput {
  trigger: string; // boot | tick | watcher | manual
  status?: string; // defaults to "pending"
}

export interface ConsolidationRun {
  id: string;
  status: string;
  trigger: string;
  /** Items applied + completed (mirrors SweepSummary.consolidated). */
  consolidated: number;
  /** Items left claimed because the model output was unusable. */
  judge_errors: number;
  /** Items whose processing threw (LLM/transport). */
  errored: number;
  /** Stale claims returned to the pending queue before processing. */
  reclaimed: number;
  summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface RecordConsolidationOperationInput {
  run_id: string;
  /** The judged action: noop | create | augment | supersede | archive | create_new. */
  action: string;
  /** The realised outcome of the plan. */
  outcome: "applied" | "proposed" | "skipped" | "failed";
  confidence: number;
  /** A value-free rationale label (already redacted upstream — no secrets). */
  rationale: string;
  /** The submission/source identifier this op came from (e.g. the inbox item id). */
  source_id?: string | null;
  /** The target memory id when the action touched an existing doc. */
  target_id?: string | null;
}

export interface ConsolidationOperation {
  id: string;
  run_id: string;
  action: string;
  outcome: string;
  confidence: number;
  rationale: string;
  source_id: string | null;
  target_id: string | null;
}

export interface ListConsolidationRunsInput {
  status?: string;
  trigger?: string;
  /** Page size, defaulted to 50 and clamped to a 200 ceiling. */
  limit?: number;
}

export interface CompleteConsolidationRunInput {
  summary?: string | null;
  consolidated?: number;
  judge_errors?: number;
  errored?: number;
  reclaimed?: number;
}

export interface FailConsolidationRunInput {
  /** A value-free error label (no secrets / untrusted content). */
  error: string;
}

export interface ConsolidationStore {
  createConsolidationRun: (input: CreateConsolidationRunInput) => ConsolidationRun;
  getConsolidationRun: (id: string) => ConsolidationRun | null;
  listConsolidationRuns: (input?: ListConsolidationRunsInput) => ConsolidationRun[];
  recordConsolidationOperation: (
    input: RecordConsolidationOperationInput,
  ) => ConsolidationOperation;
  getConsolidationOperations: (runId: string) => ConsolidationOperation[];
  /**
   * Count `applied` intake operations recorded since `sinceIso` (exclusive) — the
   * memories intake actually created/augmented/superseded after the last groom.
   * Drives grooming's post-intake threshold trigger (spec 043 D-A). Membership is
   * by the OWNING RUN's created_at: an op counts when its run was created strictly
   * after `sinceIso`. `null` (no prior groom) counts every applied op. Only
   * `applied` ops — proposed/skipped/failed didn't change the corpus, so they don't
   * arm a groom.
   */
  countAppliedOperationsSince: (sinceIso: string | null) => number;
  // Lifecycle transitions — mirror the curation store's run guards exactly.
  startConsolidationRun: (id: string) => ConsolidationRun;
  completeConsolidationRun: (id: string, input?: CompleteConsolidationRunInput) => ConsolidationRun;
  failConsolidationRun: (id: string, input: FailConsolidationRunInput) => ConsolidationRun;
}
