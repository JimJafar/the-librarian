// Consolidator decision-log writer (spec 043 C1). The fail-soft seam between the
// intake pipeline (sweep + apply) and the `ConsolidationStore` sidecar.
//
// CRUCIAL CONTRACT: intake is the perf-sensitive ingestion path, and this log is
// purely observational. A log-write failure must NEVER block or fail the sweep.
// Every write goes through `safe()` here, which swallows ANY throw (surfacing it
// only via the optional `onError` debug sink) and returns a sentinel. The sweep
// proceeds and returns its normal summary even if the store throws on every call.
//
// The pipeline depends only on this narrow `ConsolidationLogger` surface (a
// subset of `ConsolidationStore`'s write methods), so a test can inject a
// throwing logger to pin the fail-soft guarantee without a real store.

import { redactSecrets } from "../curator-redaction.js";
import type {
  CompleteConsolidationRunInput,
  ConsolidationOperation,
  ConsolidationRun,
  CreateConsolidationRunInput,
  FailConsolidationRunInput,
  RecordConsolidationOperationInput,
} from "../store/consolidation-store.js";
import type { ConsolidationOutcome } from "./apply.js";
import type { ConsolidationPlan } from "./judge.js";

/** The write-only subset of `ConsolidationStore` the intake pipeline records to. */
export interface ConsolidationLogger {
  createConsolidationRun: (input: CreateConsolidationRunInput) => ConsolidationRun;
  recordConsolidationOperation: (
    input: RecordConsolidationOperationInput,
  ) => ConsolidationOperation;
  startConsolidationRun: (id: string) => ConsolidationRun;
  completeConsolidationRun: (id: string, input?: CompleteConsolidationRunInput) => ConsolidationRun;
  failConsolidationRun: (id: string, input: FailConsolidationRunInput) => ConsolidationRun;
}

/** Optional debug sink for a swallowed log-write error (never thrown onward). */
export type LogErrorSink = (error: unknown) => void;

/**
 * Run `fn`, swallowing ANY throw so a log-write failure can never escape into the
 * sweep. Returns `fn`'s result, or `undefined` when it threw. This is the single
 * choke point that makes the decision log fail-soft — keep all writes behind it.
 */
function safe<T>(fn: () => T, onError?: LogErrorSink): T | undefined {
  try {
    return fn();
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

/**
 * Open a consolidation run + mark it running, fail-soft. Returns the run id (for
 * subsequent per-op + completion writes) or `undefined` if logging is off / the
 * store threw — callers MUST treat `undefined` as "logging unavailable, skip it".
 */
export function openConsolidationRun(
  logger: ConsolidationLogger | undefined,
  input: CreateConsolidationRunInput,
  onError?: LogErrorSink,
): string | undefined {
  if (!logger) return undefined;
  const run = safe(() => logger.createConsolidationRun(input), onError);
  if (!run) return undefined;
  safe(() => logger.startConsolidationRun(run.id), onError);
  return run.id;
}

/** Complete a consolidation run with its sweep summary, fail-soft (best-effort). */
export function completeConsolidationRun(
  logger: ConsolidationLogger | undefined,
  runId: string | undefined,
  input: CompleteConsolidationRunInput,
  onError?: LogErrorSink,
): void {
  if (!logger || !runId) return;
  safe(() => logger.completeConsolidationRun(runId, input), onError);
}

/** Fail a consolidation run with a value-free label, fail-soft (best-effort). */
export function failConsolidationRun(
  logger: ConsolidationLogger | undefined,
  runId: string | undefined,
  error: string,
  onError?: LogErrorSink,
): void {
  if (!logger || !runId) return;
  safe(() => logger.failConsolidationRun(runId, { error }), onError);
}

/** Map an apply `ConsolidationOutcome` to a decision-log `outcome`. */
function outcomeOf(outcome: ConsolidationOutcome): RecordConsolidationOperationInput["outcome"] {
  switch (outcome.kind) {
    case "created":
    case "augmented":
    case "superseded":
    case "archived":
    case "created_new":
      return "applied";
    case "proposed":
      return "proposed";
    case "skipped":
      return "skipped";
    case "rejected":
      return "failed";
  }
}

/** The target memory id an outcome touched, when it has one. */
function targetOf(outcome: ConsolidationOutcome): string | null {
  return "id" in outcome ? outcome.id : null;
}

/**
 * Record ONE per-item decision (the judged action + realised outcome + confidence
 * + rationale + source/target id), fail-soft. Called for EVERY applied item — not
 * just auto-applies — so skipped/proposed/failed rows are logged too (full
 * coverage). The model's rationale is UNTRUSTED, so it is redacted before logging
 * (same posture as apply.ts persisting it into the vault). The whole write —
 * redaction included — is inside `safe`, so even a redaction throw can't escape.
 */
export function recordConsolidationDecision(
  logger: ConsolidationLogger | undefined,
  runId: string | undefined,
  plan: ConsolidationPlan,
  outcome: ConsolidationOutcome,
  sourceId: string | null,
  onError?: LogErrorSink,
): void {
  if (!logger || !runId) return;
  // Everything that could throw — the outcome/target mapping, redaction, and the
  // store write — is inside `safe`, so no part of recording an op can escape.
  safe(
    () =>
      logger.recordConsolidationOperation({
        run_id: runId,
        action: plan.judgment.action,
        outcome: outcomeOf(outcome),
        confidence: plan.judgment.confidence,
        rationale: redactSecrets(plan.judgment.rationale).redacted,
        source_id: sourceId,
        target_id: targetOf(outcome),
      }),
    onError,
  );
}
