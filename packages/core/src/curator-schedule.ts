// Curator schedule gating (spec §14 + §7.2). Pure helpers the scheduler uses to
// decide whether a slice is due to run:
//
//   - the INTERVAL — every N days at HH:MM, computed from the last completed run
//     (default every 1 day at 03:00, §7.1);
//   - SELF-GATING — even when the interval is due, run only if enough new sessions
//     accumulated (min_sessions_since_run) OR it has been too long (max_days_since_run,
//     forces at least weekly). An idle store therefore produces no run and no LLM
//     cost (§7.2).
//
// Times are interpreted in UTC for v1; deployment-timezone handling is a wiring
// concern for the server-side scheduler (it can pass a tz-adjusted `now`).

export interface ScheduleConfig {
  /** Whole days between runs (≥ 1). */
  intervalDays: number;
  /** Time of day "HH:MM" (24-hour) the run becomes due. */
  time: string;
  /** Minimum new sessions since the last run to run at all (self-gate floor). */
  minSessions: number;
  /** Maximum days since the last run before a run is forced regardless of sessions. */
  maxDays: number;
}

export interface SliceState {
  /** When the slice's last run completed, or null if it has never run. */
  lastCompletedAt: Date | null;
  /** New sessions in the slice since the last completed run. */
  newSessionCount: number;
}

export type DueReason =
  | "interval_not_reached"
  | "never_run"
  | "min_sessions"
  | "max_days"
  | "self_gated";

export interface DueDecision {
  due: boolean;
  reason: DueReason;
}

const MS_PER_DAY = 86_400_000;

/** The next scheduled run time: last-completed + intervalDays, set to HH:MM (UTC). */
export function nextScheduledRun(lastCompletedAt: Date, intervalDays: number, time: string): Date {
  const [hours, minutes] = parseTime(time);
  const next = new Date(lastCompletedAt.getTime());
  next.setUTCDate(next.getUTCDate() + intervalDays);
  next.setUTCHours(hours, minutes, 0, 0);
  return next;
}

/** Has the interval elapsed? A slice that has never run is always interval-due. */
export function isIntervalDue(
  now: Date,
  lastCompletedAt: Date | null,
  config: ScheduleConfig,
): boolean {
  if (lastCompletedAt === null) return true;
  return (
    now.getTime() >= nextScheduledRun(lastCompletedAt, config.intervalDays, config.time).getTime()
  );
}

/**
 * Decide whether a slice should run now: the interval must be due AND the
 * self-gate must pass (enough new sessions, or max_days forces it). Returns the
 * gating reason for observability.
 */
export function isSliceDue(now: Date, state: SliceState, config: ScheduleConfig): DueDecision {
  if (!isIntervalDue(now, state.lastCompletedAt, config)) {
    return { due: false, reason: "interval_not_reached" };
  }
  if (state.lastCompletedAt === null) {
    return { due: true, reason: "never_run" };
  }
  const daysSince = (now.getTime() - state.lastCompletedAt.getTime()) / MS_PER_DAY;
  if (daysSince >= config.maxDays) return { due: true, reason: "max_days" };
  if (state.newSessionCount >= config.minSessions) return { due: true, reason: "min_sessions" };
  return { due: false, reason: "self_gated" };
}

function parseTime(time: string): [number, number] {
  const [h, m] = time.split(":");
  const hours = Number(h);
  const minutes = Number(m);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    throw new Error(`invalid schedule time: ${time}`);
  }
  return [hours, minutes];
}
