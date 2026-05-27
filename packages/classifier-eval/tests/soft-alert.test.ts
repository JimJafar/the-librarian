// Soft-alert helper computes the max_retries rate over a window
// and flags when it crosses the configured threshold (spec §4.3).

import { describe, expect, it } from "vitest";
import { computeSoftAlert } from "../src/soft-alert.js";

const ok = { fallback_used: undefined };
const parse = { fallback_used: "parse" as const };
const max = { fallback_used: "max_retries" as const };

describe("computeSoftAlert", () => {
  it("returns zero rate on empty input", () => {
    const result = computeSoftAlert({ classifications: [] });
    expect(result).toEqual({
      maxRetriesCount: 0,
      windowSize: 0,
      rate: 0,
      exceedsThreshold: false,
    });
  });

  it("flags when more than 20% of the last 100 hit max_retries", () => {
    const events = [...Array(21).fill(max), ...Array(79).fill(ok)];
    const result = computeSoftAlert({ classifications: events });
    expect(result.maxRetriesCount).toBe(21);
    expect(result.windowSize).toBe(100);
    expect(result.rate).toBe(0.21);
    expect(result.exceedsThreshold).toBe(true);
  });

  it("does NOT flag at exactly 20/100 (spec says 'more than 20%')", () => {
    const events = [...Array(20).fill(max), ...Array(80).fill(ok)];
    const result = computeSoftAlert({ classifications: events });
    expect(result.rate).toBe(0.2);
    expect(result.exceedsThreshold).toBe(false);
  });

  it("only counts max_retries — other fallbacks don't count toward the alert", () => {
    const events = [...Array(50).fill(parse), ...Array(50).fill(ok)];
    const result = computeSoftAlert({ classifications: events });
    expect(result.maxRetriesCount).toBe(0);
    expect(result.exceedsThreshold).toBe(false);
  });

  it("honours a custom window size", () => {
    const events = [...Array(11).fill(max), ...Array(39).fill(ok)];
    const result = computeSoftAlert({ classifications: events, window: 50 });
    expect(result.windowSize).toBe(50);
    expect(result.rate).toBeGreaterThan(0.2);
    expect(result.exceedsThreshold).toBe(true);
  });

  it("honours a custom threshold", () => {
    const events = [...Array(6).fill(max), ...Array(94).fill(ok)];
    const result = computeSoftAlert({ classifications: events, threshold: 0.05 });
    expect(result.rate).toBeGreaterThan(0.05);
    expect(result.exceedsThreshold).toBe(true);
  });
});
