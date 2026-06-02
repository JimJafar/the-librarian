// Consolidator — inbox sweep (spec 035 §F5 / Open-Q #2). Processes the whole
// inbox once: reclaim crashed-worker claims, then walk the pending items in FIFO
// order through `consolidateInboxItem` one at a time (serial — batching is
// deferred). This is the single entry point the boot scan, the 5-minute
// safety-net tick, and the chokidar watcher all call; the scheduler that wires
// those triggers is a separate increment.
//
// One item's failure never aborts the sweep: a thrown LLM/transport error leaves
// that item's claim in `.processing/` for the next sweep's reaper to retry.

import { listInbox, releaseStaleClaims } from "../store/corpus/inbox.js";
import { type ConsolidateInboxItemDeps, consolidateInboxItem } from "./consolidate.js";

// A claim still in `.processing/` past this age is treated as a crashed worker
// and reclaimed (matches the curator's lock TTL). With a serial single-process
// sweep, this only fires after a real crash.
const DEFAULT_LOCK_TTL_MS = 60 * 60_000; // 60 minutes

export interface ConsolidatorSweepDeps extends ConsolidateInboxItemDeps {
  /** Claims older than this are reclaimed before the sweep (default 60 min). */
  lockTtlMs?: number;
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

export async function runConsolidatorSweep(deps: ConsolidatorSweepDeps): Promise<SweepSummary> {
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

  // Serial FIFO over the (reclaimed-inclusive) pending snapshot. One item at a time.
  for (const pendingPath of listInbox(deps.vault)) {
    try {
      const result = await consolidateInboxItem(pendingPath, deps);
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
  return summary;
}
