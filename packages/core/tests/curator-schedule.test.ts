// Grooming wall-clock schedule (spec 045 D-3/D-3b). `isScheduleDue` is a
// days-only wall-clock gate the Grooming scheduler uses to decide whether a
// *pass* is due (the old per-slice minute-interval gate — isIntervalDue /
// isSliceDue — is retired in plan 046 T4; idempotency now decides which slices
// work). It anchors to the server's local time, so the tests pin
// `process.env.TZ` before importing the module under test to make the local-time
// arithmetic deterministic (especially the DST day). Pick a DST-observing zone so
// the spring-forward and fall-back edges are exercised: America/New_York springs
// forward 2025-03-09 at 02:00 (→03:00) and falls back 2025-11-02 at 02:00 (→01:00).
process.env.TZ = "America/New_York";

import { isScheduleDue, nextScheduleFire } from "@librarian/core";
import { describe, expect, it } from "vitest";

// Build a Date from explicit local-time components (America/New_York above).
// Using component construction (not a UTC ISO string) is what keeps the wall
// clock anchored across DST, which is the whole point of the helper.
const local = (year: number, month: number, day: number, hour = 0, minute = 0): Date =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

// ---------------------------------------------------------------------------
// isScheduleDue / nextScheduleFire — the Grooming wall-clock gate (spec 045
// D-3/D-3b). Days-only: next fire = lastRunAt's *local date* + intervalDays
// calendar days, anchored at the local `time`. Never-run ⇒ due once `now` has
// reached today's `time`. All times below are America/New_York (set at file
// top) unless an explicit `Z` says otherwise.
// ---------------------------------------------------------------------------

describe("nextScheduleFire", () => {
  it("anchors the next fire to local {time} on lastRunAt's date + intervalDays", () => {
    // Ran 2025-06-01 at 14:30 local, every 1 day → next fire 2025-06-02 03:00 local.
    expect(nextScheduleFire(local(2025, 6, 1, 14, 30), 1, "03:00").getTime()).toBe(
      local(2025, 6, 2, 3, 0).getTime(),
    );
  });

  it("advances by interval-days arithmetic (weekly = 7)", () => {
    // Ran 2025-06-01 23:00 local, every 7 days → 2025-06-08 03:00 local.
    expect(nextScheduleFire(local(2025, 6, 1, 23, 0), 7, "03:00").getTime()).toBe(
      local(2025, 6, 8, 3, 0).getTime(),
    );
  });

  it("keeps the wall-clock hour put across a spring-forward DST boundary", () => {
    // America/New_York springs forward 2025-03-09. Ran 2025-03-02 03:00 local,
    // every 7 days → 2025-03-09 03:00 local — still 03:00 on the wall clock, even
    // though the UTC offset changed (EST→EDT). A blind +N*86400000ms would land
    // an hour off; component construction keeps 03:00 ≈ 03:00.
    const fire = nextScheduleFire(local(2025, 3, 2, 3, 0), 7, "03:00");
    expect(fire.getHours()).toBe(3);
    expect(fire.getTime()).toBe(local(2025, 3, 9, 3, 0).getTime());
  });
});

describe("isScheduleDue — never run", () => {
  const opts = { intervalDays: 1, time: "03:00" };

  it("is NOT due before today's local {time} has passed", () => {
    // 02:59 local, before 03:00 → the next occurrence of 03:00 hasn't passed.
    expect(isScheduleDue(local(2025, 6, 1, 2, 59), null, opts)).toBe(false);
  });

  it("is due at exactly today's local {time}", () => {
    expect(isScheduleDue(local(2025, 6, 1, 3, 0), null, opts)).toBe(true);
  });

  it("is due after today's local {time}", () => {
    expect(isScheduleDue(local(2025, 6, 1, 9, 0), null, opts)).toBe(true);
  });
});

describe("isScheduleDue — has run before", () => {
  const opts = { intervalDays: 1, time: "03:00" };

  it("is NOT due before the next fire (day boundary, before {time})", () => {
    // Ran 2025-06-01 03:00; next fire 2025-06-02 03:00. At 2025-06-02 02:59 → not due.
    expect(isScheduleDue(local(2025, 6, 2, 2, 59), local(2025, 6, 1, 3, 0), opts)).toBe(false);
  });

  it("is due at the next fire (day boundary, at {time})", () => {
    expect(isScheduleDue(local(2025, 6, 2, 3, 0), local(2025, 6, 1, 3, 0), opts)).toBe(true);
  });

  it("ran earlier today → NOT due again today (once-per-window guard)", () => {
    // Ran 2025-06-01 03:00; next fire is 2025-06-02 03:00. Any later check the
    // same day (e.g. the ~15-min poll at 03:15, or 23:59) must not re-fire.
    expect(isScheduleDue(local(2025, 6, 1, 3, 15), local(2025, 6, 1, 3, 0), opts)).toBe(false);
    expect(isScheduleDue(local(2025, 6, 1, 23, 59), local(2025, 6, 1, 3, 0), opts)).toBe(false);
  });

  it("honours interval-days arithmetic (every 7 days)", () => {
    const weekly = { intervalDays: 7, time: "03:00" };
    const ran = local(2025, 6, 1, 3, 0);
    // Day 6 after the run: not yet due.
    expect(isScheduleDue(local(2025, 6, 7, 9, 0), ran, weekly)).toBe(false);
    // Day 7 at 02:59: still not due. At 03:00: due.
    expect(isScheduleDue(local(2025, 6, 8, 2, 59), ran, weekly)).toBe(false);
    expect(isScheduleDue(local(2025, 6, 8, 3, 0), ran, weekly)).toBe(true);
  });

  it("a run that completed after {time} still anchors the next fire to {time}", () => {
    // Ran 2025-06-01 14:30 (a manual run-now, say). Next fire anchors to the
    // *date* + intervalDays at {time}, not lastRunAt + 24h: 2025-06-02 03:00.
    const ran = local(2025, 6, 1, 14, 30);
    expect(isScheduleDue(local(2025, 6, 2, 2, 59), ran, opts)).toBe(false);
    expect(isScheduleDue(local(2025, 6, 2, 3, 0), ran, opts)).toBe(true);
  });
});

describe("isScheduleDue — DST", () => {
  it("does not double-fire across a fall-back day (once-per-window)", () => {
    // America/New_York falls back 2025-11-02 (02:00 EDT → 01:00 EST); the day
    // has 25 hours. A nightly 03:00 pass that ran 2025-11-02 03:00 must not fire
    // again later that same (long) day — the next fire is 2025-11-03 03:00.
    const ran = local(2025, 11, 2, 3, 0);
    const opts = { intervalDays: 1, time: "03:00" };
    expect(isScheduleDue(local(2025, 11, 2, 23, 59), ran, opts)).toBe(false);
    expect(isScheduleDue(local(2025, 11, 3, 2, 59), ran, opts)).toBe(false);
    expect(isScheduleDue(local(2025, 11, 3, 3, 0), ran, opts)).toBe(true);
  });

  it("fires on the first poll past the (non-existent) spring-forward {time}", () => {
    // America/New_York springs forward 2025-03-09: 02:00 EST jumps to 03:00 EDT,
    // so a schedule at 02:30 has no real instant that day. new Date(...,2,30)
    // normalises forward to 03:30 EDT, so a poll at/after 03:30 local is due —
    // i.e. it fires on the first check once the clock has passed the slot. We
    // accept "fires on the first poll past it" rather than skipping the window.
    const ran = local(2025, 3, 8, 2, 30); // ran the prior day at 02:30
    const opts = { intervalDays: 1, time: "02:30" };
    // 2025-03-09 02:30 doesn't exist; the engine treats the slot as 03:30 EDT.
    expect(isScheduleDue(local(2025, 3, 9, 3, 30), ran, opts)).toBe(true);
    // And once it has run that window (lastRunAt on the 9th), it won't re-fire.
    const ranToday = local(2025, 3, 9, 3, 30);
    expect(isScheduleDue(local(2025, 3, 9, 12, 0), ranToday, opts)).toBe(false);
  });
});
