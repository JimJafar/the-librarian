// Intake (intake) decision-log store — shared type contract (spec 043 C1).
//
// The intake pipeline's full-outcome decision log, mirroring grooming's
// `CurationStore` run/operation shape (`curation-types.ts`) but for the
// intake sweep. It is a purely observational sidecar: it records what the
// intake judge decided + how each plan was applied (applied | proposed | skipped
// | failed) and NEVER influences filing. The concrete JSON-sidecar implementation
// lives in `sidecar/intake-store.ts`; the contract is re-exported from
// `intake-store.ts` to match the curation-store layering.
//
// Unlike grooming, intake has no slice/evidence/lock seam (one submission at a
// time, not a batched curation pass), so this store is deliberately the minimal
// run + operation subset of `CurationStore` — no `gatherMemoryEvidence` /
// `listCuratorSlices` / `findRunningRun`.

export interface CreateIntakeRunInput {
  trigger: string; // boot | tick | watcher | manual
  status?: string; // defaults to "pending"
}

export interface IntakeRun {
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

export interface RecordIntakeOperationInput {
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

export interface IntakeOperation {
  id: string;
  run_id: string;
  action: string;
  outcome: string;
  confidence: number;
  rationale: string;
  source_id: string | null;
  target_id: string | null;
}

export interface ListIntakeRunsInput {
  status?: string;
  trigger?: string;
  /** Page size, defaulted to 50 and clamped to a 200 ceiling. */
  limit?: number;
}

export interface CompleteIntakeRunInput {
  summary?: string | null;
  consolidated?: number;
  judge_errors?: number;
  errored?: number;
  reclaimed?: number;
}

export interface FailIntakeRunInput {
  /** A value-free error label (no secrets / untrusted content). */
  error: string;
}

export interface IntakeStore {
  createIntakeRun: (input: CreateIntakeRunInput) => IntakeRun;
  getIntakeRun: (id: string) => IntakeRun | null;
  listIntakeRuns: (input?: ListIntakeRunsInput) => IntakeRun[];
  recordIntakeOperation: (input: RecordIntakeOperationInput) => IntakeOperation;
  getIntakeOperations: (runId: string) => IntakeOperation[];
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
  startIntakeRun: (id: string) => IntakeRun;
  completeIntakeRun: (id: string, input?: CompleteIntakeRunInput) => IntakeRun;
  failIntakeRun: (id: string, input: FailIntakeRunInput) => IntakeRun;
}
