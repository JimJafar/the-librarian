import type { ChronicleDay } from "./config.js";
import type { ChroniclePeriod } from "./types.js";

export interface ChronicleScheduleSpec {
  dayOfWeek: ChronicleDay;
  scheduleTime: string;
}

const DAY_OFFSET: Record<ChronicleDay, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

export function isChronicleScheduleDue(
  now: Date,
  lastRunAt: Date | null,
  spec: ChronicleScheduleSpec,
): boolean {
  const fire = scheduledFireInCurrentWeek(now, spec);
  if (lastRunAt === null) return now.getTime() >= fire.getTime();

  const latestFire = latestChronicleScheduleFire(now, spec);
  return lastRunAt.getTime() < latestFire.getTime();
}

/** The most recent configured weekly fire at or before `now`, in server-local time. */
export function latestChronicleScheduleFire(now: Date, spec: ChronicleScheduleSpec): Date {
  const fire = scheduledFireInCurrentWeek(now, spec);
  return now.getTime() >= fire.getTime() ? fire : shiftLocalDays(fire, -7);
}

export function currentChroniclePeriod(now: Date): ChroniclePeriod {
  const start = localWeekStart(now);
  return {
    start: start.toISOString(),
    end: now.toISOString(),
    isoWeek: isoWeekLabel(start),
    partial: true,
    throughDate: localDateLabel(now),
  };
}

function localDateLabel(value: Date): string {
  return [
    String(value.getFullYear()).padStart(4, "0"),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

export function previousChroniclePeriod(now: Date): ChroniclePeriod {
  const end = localWeekStart(now);
  const start = shiftLocalDays(end, -7);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    isoWeek: isoWeekLabel(start),
    partial: false,
  };
}

/**
 * The completed ISO week owned by the latest scheduled fire. Deriving this from
 * the fire (rather than the catch-up poll time) prevents a missed non-Monday run
 * from jumping forward a week when the server returns after an ISO-week boundary.
 */
export function scheduledChroniclePeriod(now: Date, spec: ChronicleScheduleSpec): ChroniclePeriod {
  return previousChroniclePeriod(latestChronicleScheduleFire(now, spec));
}

function scheduledFireInCurrentWeek(now: Date, spec: ChronicleScheduleSpec): Date {
  const [hourRaw, minuteRaw] = spec.scheduleTime.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    throw new Error(`Expected Chronicle schedule time as 24h HH:MM, got "${spec.scheduleTime}"`);
  }
  const monday = localWeekStart(now);
  return new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + DAY_OFFSET[spec.dayOfWeek],
    hour,
    minute,
    0,
    0,
  );
}

function localWeekStart(value: Date): Date {
  const midnight = new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
  const daysSinceMonday = (midnight.getDay() + 6) % 7;
  return shiftLocalDays(midnight, -daysSinceMonday);
}

function shiftLocalDays(value: Date, days: number): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate() + days,
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
    value.getMilliseconds(),
  );
}

function isoWeekLabel(localMonday: Date): string {
  const probe = new Date(
    Date.UTC(localMonday.getFullYear(), localMonday.getMonth(), localMonday.getDate()),
  );
  const day = probe.getUTCDay() || 7;
  probe.setUTCDate(probe.getUTCDate() + 4 - day);
  const weekYear = probe.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((probe.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}
