// The regression gate: a metric that drops past the tolerance fails; small
// noise within tolerance passes; a baseline metric of null is ignored; and a
// metric that vanishes (null where the baseline had a value) is a regression.

import { describe, expect, it } from "vitest";
import { type Baseline, BaselineSchema, type EvalReport, compareToBaseline } from "../src/index.js";

function report(over: Partial<EvalReport>): EvalReport {
  return {
    sample_size: 8,
    filing_accuracy: 0.9,
    decision_band_accuracy: 0.9,
    no_clobber_rate: 1,
    contradiction_recall: 1,
    entity_resolution: 1,
    parse_error_count: 0,
    by_scenario: {} as EvalReport["by_scenario"],
    samples: [],
    ...over,
  };
}

const baseline: Baseline = {
  filing_accuracy: 0.9,
  decision_band_accuracy: 0.9,
  no_clobber_rate: 1,
  contradiction_recall: 1,
  entity_resolution: 1,
};

describe("compareToBaseline", () => {
  it("passes when metrics match the baseline", () => {
    expect(compareToBaseline(report({}), baseline).passed).toBe(true);
  });

  it("passes a drop within tolerance", () => {
    expect(compareToBaseline(report({ filing_accuracy: 0.86 }), baseline, 0.05).passed).toBe(true);
  });

  it("fails a drop past tolerance and names the metric", () => {
    const gate = compareToBaseline(report({ filing_accuracy: 0.7 }), baseline, 0.05);
    expect(gate.passed).toBe(false);
    expect(gate.regressions.map((r) => r.metric)).toEqual(["filing_accuracy"]);
    expect(gate.regressions[0]!.delta).toBeCloseTo(-0.2, 5);
  });

  it("does not flag an improvement", () => {
    expect(compareToBaseline(report({ filing_accuracy: 1 }), baseline).passed).toBe(true);
  });

  it("ignores a baseline metric that is null", () => {
    const partial: Baseline = { ...baseline, no_clobber_rate: null };
    expect(compareToBaseline(report({ no_clobber_rate: null }), partial).passed).toBe(true);
  });

  it("treats a vanished metric as a regression to zero", () => {
    const gate = compareToBaseline(report({ contradiction_recall: null }), baseline);
    expect(gate.passed).toBe(false);
    expect(gate.regressions.map((r) => r.metric)).toContain("contradiction_recall");
  });
});

describe("BaselineSchema", () => {
  it("rejects an empty baseline (so a gate can't silently pass on no data)", () => {
    expect(() => BaselineSchema.parse({})).toThrow();
  });

  it("rejects an out-of-range metric", () => {
    expect(() => BaselineSchema.parse({ ...baseline, filing_accuracy: 1.5 })).toThrow();
  });

  it("accepts a well-formed baseline (with nulls)", () => {
    expect(() => BaselineSchema.parse({ ...baseline, no_clobber_rate: null })).not.toThrow();
  });
});
