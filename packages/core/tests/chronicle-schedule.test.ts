import {
  currentChroniclePeriod,
  isChronicleScheduleDue,
  previousChroniclePeriod,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("isChronicleScheduleDue", () => {
  const schedule = { dayOfWeek: "monday" as const, scheduleTime: "08:00" };

  it("opens one weekly local-time window and catches up after a missed poll", () => {
    expect(isChronicleScheduleDue(new Date(2026, 7, 3, 7, 59), null, schedule)).toBe(false);
    expect(isChronicleScheduleDue(new Date(2026, 7, 3, 8, 0), null, schedule)).toBe(true);
    expect(isChronicleScheduleDue(new Date(2026, 7, 4, 12, 0), null, schedule)).toBe(true);
    expect(
      isChronicleScheduleDue(new Date(2026, 7, 4, 12, 0), new Date(2026, 7, 3, 8, 5), schedule),
    ).toBe(false);
    expect(
      isChronicleScheduleDue(new Date(2026, 7, 10, 8, 0), new Date(2026, 7, 3, 8, 5), schedule),
    ).toBe(true);
  });
});

describe("Chronicle ISO-week periods", () => {
  it("makes Run now the current local ISO week to date", () => {
    const now = new Date(2026, 6, 29, 13, 45);
    expect(currentChroniclePeriod(now)).toEqual({
      start: new Date(2026, 6, 27, 0, 0, 0, 0).toISOString(),
      end: now.toISOString(),
      isoWeek: "2026-W31",
      partial: true,
    });
  });

  it("makes scheduled runs the previous completed local ISO week", () => {
    expect(previousChroniclePeriod(new Date(2026, 7, 3, 8, 0))).toEqual({
      start: new Date(2026, 6, 27, 0, 0, 0, 0).toISOString(),
      end: new Date(2026, 7, 3, 0, 0, 0, 0).toISOString(),
      isoWeek: "2026-W31",
      partial: false,
    });
  });

  it("uses the ISO week-year across a calendar-year boundary", () => {
    expect(currentChroniclePeriod(new Date(2027, 0, 1, 12, 0)).isoWeek).toBe("2026-W53");
  });
});
