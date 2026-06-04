// Curator due-slice selection (sessions-rethink spec §12.4). Composes
// candidate-slice enumeration with the last-completed-run lookup into the set
// of slices that should run now under the interval gate. Read-only; the
// server-side scheduler wraps this with a timer + slice locking, and runs
// each due slice via runCuration as the system-memory-curator actor.
//
// Run-history reads go through `CurationRunReader`, so this module is pure over
// where the runs live: the sidecar JSON run store (curation-runs.json) supplies
// the reader. The scheduler never touches storage directly.

import type { CuratorMemorySource, EvidenceSlice } from "./curator-evidence.js";
import { type DueReason, type ScheduleConfig, isSliceDue } from "./curator-schedule.js";

export interface DueSlice {
  slice: EvidenceSlice;
  reason: DueReason;
  lastCompletedAt: Date | null;
}

/**
 * The run-history reads the scheduler needs, abstracted over where runs live.
 * The sidecar JSON run store (curation-runs.json) provides the concrete reader.
 */
export interface CurationRunReader {
  /** Latest completed run time for a slice, or null if it has never completed. */
  lastCompletedRunAt(slice: EvidenceSlice): Date | null;
  /**
   * The latest in-progress (running) run for a slice — the §10.1 lock. A non-null
   * result means the slice is being worked; the caller compares startedAt against a
   * TTL to distinguish an active lock from a stale (crashed-worker) one to reclaim.
   */
  findRunningRun(slice: EvidenceSlice): { id: string; startedAt: Date } | null;
}

export function selectDueSlices(
  memorySource: CuratorMemorySource,
  runReader: CurationRunReader,
  config: ScheduleConfig,
  now: Date,
): DueSlice[] {
  const due: DueSlice[] = [];
  for (const slice of memorySource.listSlices()) {
    const lastCompletedAt = runReader.lastCompletedRunAt(slice);
    const decision = isSliceDue(now, { lastCompletedAt }, config);
    if (decision.due) due.push({ slice, reason: decision.reason, lastCompletedAt });
  }
  return due;
}
