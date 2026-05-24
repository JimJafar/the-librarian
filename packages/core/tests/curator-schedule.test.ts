// Curator schedule gating (spec §14 + §7.2). Pure logic the scheduler uses to
// decide whether a slice is due: the interval (every N days at HH:MM, computed
// from the last completed run) plus self-gating on min_sessions_since_run /
// max_days_since_run, so an idle store produces no run (and no LLM cost) even
// when the interval comes due.

import { type ScheduleConfig, isIntervalDue, isSliceDue, nextScheduledRun } from "@librarian/core";
import { describe, expect, it } from "vitest";

const d = (iso: string) => new Date(iso);
const config = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  intervalDays: 1,
  time: "03:00",
  minSessions: 10,
  maxDays: 7,
  ...over,
});

describe("nextScheduledRun", () => {
  it("is last-completed + intervalDays at the configured time", () => {
    expect(nextScheduledRun(d("2026-05-23T03:05:00Z"), 1, "03:00").toISOString()).toBe(
      "2026-05-24T03:00:00.000Z",
    );
    expect(nextScheduledRun(d("2026-05-20T23:00:00Z"), 3, "06:30").toISOString()).toBe(
      "2026-05-23T06:30:00.000Z",
    );
  });
});

describe("isIntervalDue", () => {
  it("is due when never run", () => {
    expect(isIntervalDue(d("2026-05-24T00:00:00Z"), null, config())).toBe(true);
  });
  it("is not due before the next scheduled time", () => {
    expect(isIntervalDue(d("2026-05-24T02:59:00Z"), d("2026-05-23T03:00:00Z"), config())).toBe(
      false,
    );
  });
  it("is due at/after the next scheduled time", () => {
    expect(isIntervalDue(d("2026-05-24T03:00:00Z"), d("2026-05-23T03:00:00Z"), config())).toBe(
      true,
    );
    expect(isIntervalDue(d("2026-05-24T09:00:00Z"), d("2026-05-23T03:00:00Z"), config())).toBe(
      true,
    );
  });
});

describe("isSliceDue", () => {
  it("not due when the interval has not been reached", () => {
    const decision = isSliceDue(
      d("2026-05-24T02:00:00Z"),
      { lastCompletedAt: d("2026-05-23T03:00:00Z"), newSessionCount: 100 },
      config(),
    );
    expect(decision).toEqual({ due: false, reason: "interval_not_reached" });
  });

  it("due on first run (never run)", () => {
    const decision = isSliceDue(
      d("2026-05-24T03:00:00Z"),
      { lastCompletedAt: null, newSessionCount: 0 },
      config(),
    );
    expect(decision).toEqual({ due: true, reason: "never_run" });
  });

  it("due when enough new sessions accumulated", () => {
    const decision = isSliceDue(
      d("2026-05-24T03:00:00Z"),
      { lastCompletedAt: d("2026-05-23T03:00:00Z"), newSessionCount: 12 },
      config({ minSessions: 10 }),
    );
    expect(decision).toEqual({ due: true, reason: "min_sessions" });
  });

  it("self-gates when the interval is due but too few new sessions", () => {
    const decision = isSliceDue(
      d("2026-05-24T03:00:00Z"),
      { lastCompletedAt: d("2026-05-23T03:00:00Z"), newSessionCount: 2 },
      config({ minSessions: 10, maxDays: 7 }),
    );
    expect(decision).toEqual({ due: false, reason: "self_gated" });
  });

  it("forces a run past max_days even with too few sessions", () => {
    const decision = isSliceDue(
      d("2026-05-31T03:00:00Z"),
      { lastCompletedAt: d("2026-05-23T03:00:00Z"), newSessionCount: 0 },
      config({ minSessions: 10, maxDays: 7 }),
    );
    expect(decision).toEqual({ due: true, reason: "max_days" });
  });
});
