// Ratio-preserving trim — pure function tests.

import { describe, expect, it } from "vitest";
import type { FixtureEntry } from "../src/fixture.js";
import { targetCounts, trimToTargets } from "../src/generate/trim.js";

function entry(id: string, category: FixtureEntry["category"]): FixtureEntry {
  return {
    id,
    title: id,
    body: id,
    tags: [],
    label: { requires_approval: false, is_global: false },
    category,
  };
}

describe("trimToTargets", () => {
  it("returns a slice respecting boundary ratio when both buckets overflow", () => {
    const straight = [entry("s1", "straight"), entry("s2", "straight"), entry("s3", "straight")];
    const boundary = [entry("b1", "boundary"), entry("b2", "boundary"), entry("b3", "boundary")];
    const result = trimToTargets(straight, boundary, { total: 5, boundaryRatio: 0.4 });
    expect(result.counts).toEqual({ straight: 3, boundary: 2 });
    expect(result.trimmed.map((e) => e.id)).toEqual(["s1", "s2", "s3", "b1", "b2"]);
    expect(result.targetsMet).toBe(true);
  });

  it("preserves order within each bucket (FIFO from accumulated survivors)", () => {
    const straight = [entry("s1", "straight"), entry("s2", "straight"), entry("s3", "straight")];
    const boundary: FixtureEntry[] = [entry("b1", "boundary"), entry("b2", "boundary")];
    const result = trimToTargets(straight, boundary, { total: 4, boundaryRatio: 0.5 });
    expect(result.trimmed.map((e) => e.id)).toEqual(["s1", "s2", "b1", "b2"]);
  });

  it("flags targetsMet=false when one bucket is short", () => {
    const straight: FixtureEntry[] = [entry("s1", "straight")];
    const boundary = [entry("b1", "boundary"), entry("b2", "boundary"), entry("b3", "boundary")];
    const result = trimToTargets(straight, boundary, { total: 5, boundaryRatio: 0.4 });
    expect(result.counts.straight).toBe(1);
    expect(result.counts.boundary).toBe(2);
    expect(result.targetsMet).toBe(false);
  });
});

describe("targetCounts", () => {
  it("splits the total per the boundary ratio", () => {
    expect(targetCounts({ total: 900, boundaryRatio: 0.4 })).toEqual({
      straight: 540,
      boundary: 360,
    });
    expect(targetCounts({ total: 100, boundaryRatio: 0.5 })).toEqual({
      straight: 50,
      boundary: 50,
    });
    expect(targetCounts({ total: 10, boundaryRatio: 0 })).toEqual({ straight: 10, boundary: 0 });
    expect(targetCounts({ total: 10, boundaryRatio: 1 })).toEqual({ straight: 0, boundary: 10 });
  });
});
