// Curator schedule gating (sessions-rethink spec §12.4). Pure helpers the
// scheduler uses to decide whether a slice is due to run:
//
//   - the INTERVAL — every N minutes from the last completed run (default 60).
//   - No event-driven self-gate: with sessions gone, there is no natural
//     "new write since last run" signal. Operators opt in via curator.enabled
//     and curator.interval_minutes; the scheduler honours the interval and
//     nothing else.

export interface ScheduleConfig {
  /** Whole minutes between runs (≥ 1). */
  intervalMinutes: number;
}

export interface SliceState {
  /** When the slice's last run completed, or null if it has never run. */
  lastCompletedAt: Date | null;
}

export type DueReason = "interval_not_reached" | "never_run" | "interval_reached";

export interface DueDecision {
  due: boolean;
  reason: DueReason;
}

const MS_PER_MINUTE = 60_000;

/** The next scheduled run time: last-completed + intervalMinutes. */
export function nextScheduledRun(lastCompletedAt: Date, intervalMinutes: number): Date {
  return new Date(lastCompletedAt.getTime() + intervalMinutes * MS_PER_MINUTE);
}

/** Has the interval elapsed? A slice that has never run is always due. */
export function isIntervalDue(
  now: Date,
  lastCompletedAt: Date | null,
  config: ScheduleConfig,
): boolean {
  if (lastCompletedAt === null) return true;
  return now.getTime() >= nextScheduledRun(lastCompletedAt, config.intervalMinutes).getTime();
}

/**
 * Decide whether a slice should run now: just the interval gate after the
 * sessions rethink (§12.4) — no self-gate on write volume.
 */
export function isSliceDue(now: Date, state: SliceState, config: ScheduleConfig): DueDecision {
  if (!isIntervalDue(now, state.lastCompletedAt, config)) {
    return { due: false, reason: "interval_not_reached" };
  }
  return {
    due: true,
    reason: state.lastCompletedAt === null ? "never_run" : "interval_reached",
  };
}
