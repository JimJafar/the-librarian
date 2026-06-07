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

// ---------------------------------------------------------------------------
// Grooming wall-clock schedule (spec 045 D-3/D-3b). A DAYS-ONLY nightly gate:
// "run every N days at HH:MM" in the server's LOCAL time. Distinct from the
// minute-interval gate above — the Grooming scheduler uses this to decide
// whether a *pass* is due; idempotency (D-3a) then decides which slices work.
//
// Deliberately days-only: no weeks/months unit, no calendar-month arithmetic
// (no setMonth, no month-length clamps). "Weekly" is 7, "~monthly" is 30. We
// anchor each fire to the local {time} via component construction (setHours),
// NOT a blind `+ N * 86400000` ms, so the wall-clock hour stays put across DST
// — 03:00 in winter is still 03:00 in summer.
// ---------------------------------------------------------------------------

/** A days-only wall-clock schedule: every `intervalDays` days at local `time`. */
export interface ScheduleSpec {
  /** Whole days between passes (≥ 1). */
  intervalDays: number;
  /** Local time-of-day the pass fires at, 24h `"HH:MM"`. */
  time: string;
}

/** Parse `"HH:MM"` into `{ hour, minute }`. Throws a teaching error on bad input. */
function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`Expected schedule time as 24h "HH:MM" (e.g. "03:00"), got "${time}"`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Schedule time out of range (00:00–23:59), got "${time}"`);
  }
  return { hour, minute };
}

/**
 * The next time the schedule fires after a run on `lastRunAt`: the *local date*
 * of `lastRunAt`, advanced by `intervalDays` calendar days, anchored at local
 * `time`. The wall-clock time of `lastRunAt` is irrelevant — a run-now at 14:30
 * still pins the next fire to `time` on the target date, not lastRunAt + 24h.
 *
 * Built from local date components (`new Date(y, m, d, H, M)`) so the wall clock
 * is preserved across DST: adding `intervalDays` to the day component and
 * setting H:M keeps 03:00 ≈ 03:00 even when the UTC offset shifts (EST↔EDT). On
 * a spring-forward day a non-existent local `time` (e.g. 02:30 when 02:00→03:00)
 * is normalised forward by the JS Date constructor, so the pass fires on the
 * first poll once the clock has passed the slot — see the DST note below.
 */
export function nextScheduleFire(lastRunAt: Date, intervalDays: number, time: string): Date {
  const { hour, minute } = parseTime(time);
  return new Date(
    lastRunAt.getFullYear(),
    lastRunAt.getMonth(),
    lastRunAt.getDate() + intervalDays,
    hour,
    minute,
    0,
    0,
  );
}

/** Today's local `time` as a Date, anchored to `now`'s local date. */
function todaysFire(now: Date, time: string): Date {
  const { hour, minute } = parseTime(time);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}

/**
 * Is a Grooming pass due now? Days-only wall-clock gate (D-3b).
 *
 * - **Never run** (`lastRunAt === null`): due once `now` has reached today's
 *   local `time` — i.e. `now >= todays {time}`. Before that, not due. (So a
 *   fresh install first grooms at the next `time`, not immediately at boot.)
 * - **Has run before**: due once `now >= nextScheduleFire(lastRunAt, …)` — the
 *   local date of `lastRunAt` + `intervalDays` days, at `time`. This is the
 *   once-per-window guard: because the next fire is anchored to a *later* date,
 *   any number of polls on the same day after a run stay not-due, and a
 *   25-hour fall-back day cannot double-fire.
 *
 * **DST.** Anchoring to local `time` keeps the wall-clock hour fixed across the
 * year. On the spring-forward day a `time` inside the skipped hour doesn't
 * exist; `new Date` normalises it forward (e.g. 02:30 → 03:30 EDT), so the pass
 * fires on the first poll after the clock passes the slot rather than being
 * skipped. The fall-back day is the once-per-window guard's job — covered by the
 * "later date" anchor above. We accept the rare first-poll-after-the-gap timing
 * on spring-forward; over-engineering an exact-instant gate isn't worth it for a
 * nightly maintenance job.
 */
export function isScheduleDue(now: Date, lastRunAt: Date | null, opts: ScheduleSpec): boolean {
  if (lastRunAt === null) {
    return now.getTime() >= todaysFire(now, opts.time).getTime();
  }
  return now.getTime() >= nextScheduleFire(lastRunAt, opts.intervalDays, opts.time).getTime();
}
