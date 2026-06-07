// Post-intake grooming trigger arithmetic (spec 043 D-A). The pure decision:
// trigger a groom iff applied-intake-ops-since-last-groom ≥ threshold AND we are
// outside the debounce window of the last groom. These are the unit tests for the
// threshold + debounce math; the integration (an intake burst triggers grooming
// exactly once) lives in intake-grooming-trigger.test.ts.

import { type GroomingTriggerInputs, evaluateGroomingTrigger } from "@librarian/core";
import { describe, expect, it } from "vitest";

const base = (over: Partial<GroomingTriggerInputs> = {}): GroomingTriggerInputs => ({
  threshold: 20,
  debounceMinutes: 60,
  lastGroomAt: null,
  appliedSinceLastGroom: 0,
  now: new Date("2026-06-06T12:00:00.000Z"),
  ...over,
});

describe("evaluateGroomingTrigger — threshold", () => {
  it("does not trigger below the threshold", () => {
    expect(evaluateGroomingTrigger(base({ appliedSinceLastGroom: 19 }))).toEqual({
      trigger: false,
      reason: "below_threshold",
    });
  });

  it("triggers exactly at the threshold (≥, no prior groom)", () => {
    expect(evaluateGroomingTrigger(base({ appliedSinceLastGroom: 20 }))).toEqual({ trigger: true });
  });

  it("triggers above the threshold", () => {
    expect(evaluateGroomingTrigger(base({ appliedSinceLastGroom: 100 }))).toEqual({
      trigger: true,
    });
  });

  it("honours a custom threshold", () => {
    expect(evaluateGroomingTrigger(base({ threshold: 5, appliedSinceLastGroom: 4 }))).toMatchObject(
      { trigger: false },
    );
    expect(evaluateGroomingTrigger(base({ threshold: 5, appliedSinceLastGroom: 5 }))).toEqual({
      trigger: true,
    });
  });
});

describe("evaluateGroomingTrigger — debounce", () => {
  const lastGroomAt = "2026-06-06T11:30:00.000Z"; // 30 min before `now`

  it("suppresses a second trigger inside the debounce window", () => {
    // 30 min since the last groom, debounce 60 → still inside the window.
    expect(
      evaluateGroomingTrigger(
        base({ appliedSinceLastGroom: 100, lastGroomAt, debounceMinutes: 60 }),
      ),
    ).toEqual({ trigger: false, reason: "debounced" });
  });

  it("allows a trigger once the debounce window has elapsed", () => {
    // 30 min since the last groom, debounce 30 → exactly at the floor, allowed (< not ≤).
    expect(
      evaluateGroomingTrigger(
        base({ appliedSinceLastGroom: 100, lastGroomAt, debounceMinutes: 30 }),
      ),
    ).toEqual({ trigger: true });
  });

  it("allows a trigger well past the debounce window", () => {
    expect(
      evaluateGroomingTrigger(
        base({ appliedSinceLastGroom: 100, lastGroomAt, debounceMinutes: 10 }),
      ),
    ).toEqual({ trigger: true });
  });

  it("never debounces when there is no prior groom", () => {
    expect(
      evaluateGroomingTrigger(base({ appliedSinceLastGroom: 100, lastGroomAt: null })),
    ).toEqual({ trigger: true });
  });

  it("checks the threshold first: below threshold reports below_threshold even inside the window", () => {
    expect(
      evaluateGroomingTrigger(base({ appliedSinceLastGroom: 1, lastGroomAt, debounceMinutes: 60 })),
    ).toEqual({ trigger: false, reason: "below_threshold" });
  });

  it("fails open on a malformed last-groom timestamp (does not suppress)", () => {
    expect(
      evaluateGroomingTrigger(
        base({ appliedSinceLastGroom: 100, lastGroomAt: "not-a-date", debounceMinutes: 60 }),
      ),
    ).toEqual({ trigger: true });
  });
});
