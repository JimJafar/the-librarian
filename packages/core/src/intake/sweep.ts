// Intake — inbox sweep (spec 035 §F5 / Open-Q #2). Processes the whole
// inbox once: reclaim crashed-worker claims, then walk the pending items in FIFO
// order through `intakeInboxItem` one at a time (serial — batching is
// deferred). This is the single entry point the boot scan, the 5-minute
// safety-net tick, and the chokidar watcher all call; the scheduler that wires
// those triggers is a separate increment.
//
// One item's failure never aborts the sweep: a thrown LLM/transport error leaves
// that item's claim in `.processing/` for the next sweep's reaper to retry.

import { listInbox, releaseStaleClaims } from "../store/corpus/inbox.js";
import { type IntakeLogger, completeIntakeRun, openIntakeRun } from "./decision-log.js";
import { type IntakeInboxItemDeps, intakeInboxItem } from "./intake.js";

// A claim still in `.processing/` past this age is treated as a crashed worker
// and reclaimed (matches the curator's lock TTL). With a serial single-process
// sweep, this only fires after a real crash.
const DEFAULT_LOCK_TTL_MS = 60 * 60_000; // 60 minutes

export interface IntakeSweepDeps extends IntakeInboxItemDeps {
  /** Claims older than this are reclaimed before the sweep (default 60 min). */
  lockTtlMs?: number;
  /**
   * Optional intake decision-log writer (spec 043 C1). When present, the sweep
   * opens a run, records each item's outcome, and completes the run with the
   * summary. Purely observational + fully fail-soft — a throwing logger never
   * blocks or fails the sweep (see decision-log.ts). Omit it (the default) and
   * filing behaviour is byte-identical to before this log existed.
   */
  intakeLog?: IntakeLogger;
  /** What opened this sweep (boot | tick | watcher | manual); recorded on the run. */
  intakeTrigger?: string;
}

export interface SweepSummary {
  /** Stale claims returned to the pending queue before processing. */
  reclaimed: number;
  /** Items applied + completed. */
  consolidated: number;
  /** Items left claimed because the model output was unusable (reaper retries). */
  judgeErrors: number;
  /** Items a concurrent worker had already claimed. */
  claimedByOther: number;
  /** Items whose processing threw (LLM/transport); claim left for retry. */
  errored: number;
}

export async function runIntakeSweep(deps: IntakeSweepDeps): Promise<SweepSummary> {
  const nowMs = (deps.now ?? Date.now)();
  const reclaimed = releaseStaleClaims(deps.vault, {
    olderThanMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
    now: nowMs,
  }).length;

  const summary: SweepSummary = {
    reclaimed,
    consolidated: 0,
    judgeErrors: 0,
    claimedByOther: 0,
    errored: 0,
  };

  // Open a decision-log run (fail-soft: returns undefined if logging is off or the
  // store threw, in which case every downstream log write is a no-op). `logError`
  // surfaces swallowed log failures for debug; it never propagates.
  const runId = openIntakeRun(
    deps.intakeLog,
    { trigger: deps.intakeTrigger ?? "manual" },
    deps.logError,
  );
  const itemDeps: IntakeInboxItemDeps = {
    ...deps,
    ...(runId !== undefined ? { intakeRunId: runId } : {}),
  };

  // Serial FIFO over the (reclaimed-inclusive) pending snapshot. One item at a time.
  for (const pendingPath of listInbox(deps.vault)) {
    try {
      const result = await intakeInboxItem(pendingPath, itemDeps);
      if (result.status === "consolidated") summary.consolidated++;
      else if (result.status === "judge_error") summary.judgeErrors++;
      else summary.claimedByOther++;
    } catch (error) {
      // A thrown LLM/transport error leaves the claim in `.processing/` (the
      // next sweep's reaper retries); never abort the rest of the batch.
      deps.onError?.(error);
      summary.errored++;
    }
  }

  // Complete the run with the sweep summary (fail-soft, best-effort). A no-op when
  // logging is off / the open failed.
  completeIntakeRun(
    deps.intakeLog,
    runId,
    {
      summary: `consolidated ${summary.consolidated}, judgeErrors ${summary.judgeErrors}, claimedByOther ${summary.claimedByOther}, errored ${summary.errored}, reclaimed ${summary.reclaimed}`,
      consolidated: summary.consolidated,
      judge_errors: summary.judgeErrors,
      errored: summary.errored,
      reclaimed: summary.reclaimed,
    },
    deps.logError,
  );
  return summary;
}
