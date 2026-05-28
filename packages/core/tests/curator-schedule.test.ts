// Curator schedule gating (sessions-rethink §12.4). Pure logic the scheduler
// uses to decide whether a slice is due: just the interval (every N minutes
// from the last completed run). The session-based self-gate is retired —
// disabled-by-default cadence does the throttling instead.

import { type ScheduleConfig, isIntervalDue, isSliceDue, nextScheduledRun } from "@librarian/core";
import { describe, expect, it } from "vitest";

const d = (iso: string) => new Date(iso);
const config = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  intervalMinutes: 60,
  ...over,
});

describe("nextScheduledRun", () => {
  it("is last-completed + intervalMinutes", () => {
    expect(nextScheduledRun(d("2026-05-23T03:05:00Z"), 60).toISOString()).toBe(
      "2026-05-23T04:05:00.000Z",
    );
    expect(nextScheduledRun(d("2026-05-20T23:00:00Z"), 90).toISOString()).toBe(
      "2026-05-21T00:30:00.000Z",
    );
  });
});

describe("isIntervalDue", () => {
  it("is due when never run", () => {
    expect(isIntervalDue(d("2026-05-24T00:00:00Z"), null, config())).toBe(true);
  });
  it("is not due before the interval has elapsed", () => {
    expect(isIntervalDue(d("2026-05-24T02:59:00Z"), d("2026-05-24T02:00:00Z"), config())).toBe(
      false,
    );
  });
  it("is due at/after the interval has elapsed", () => {
    expect(isIntervalDue(d("2026-05-24T03:00:00Z"), d("2026-05-24T02:00:00Z"), config())).toBe(
      true,
    );
    expect(isIntervalDue(d("2026-05-24T09:00:00Z"), d("2026-05-24T02:00:00Z"), config())).toBe(
      true,
    );
  });
});

describe("isSliceDue", () => {
  it("not due when the interval has not been reached", () => {
    const decision = isSliceDue(
      d("2026-05-24T02:30:00Z"),
      { lastCompletedAt: d("2026-05-24T02:00:00Z") },
      config(),
    );
    expect(decision).toEqual({ due: false, reason: "interval_not_reached" });
  });

  it("due on first run (never run)", () => {
    const decision = isSliceDue(d("2026-05-24T03:00:00Z"), { lastCompletedAt: null }, config());
    expect(decision).toEqual({ due: true, reason: "never_run" });
  });

  it("due once the interval has elapsed", () => {
    const decision = isSliceDue(
      d("2026-05-24T03:00:00Z"),
      { lastCompletedAt: d("2026-05-24T02:00:00Z") },
      config(),
    );
    expect(decision).toEqual({ due: true, reason: "interval_reached" });
  });
});
