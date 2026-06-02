// The regression gate. An operator runs the eval against a real model once and
// freezes the headline metrics as a baseline; later runs compare against it and
// fail if any metric drops by more than a tolerance. Pure — the CLI wires it to
// file I/O.
//
// A baseline metric of `null` means "not measured" (skip it). A metric that was
// present at baseline but is `null` in a later run counts as a regression to 0
// (the scenario silently stopped being exercised).

import { z } from "zod";
import type { EvalReport } from "./metrics.js";

export const BASELINE_METRICS = [
  "filing_accuracy",
  "decision_band_accuracy",
  "no_clobber_rate",
  "contradiction_recall",
  "entity_resolution",
] as const;

export type BaselineMetric = (typeof BASELINE_METRICS)[number];

// A baseline must carry every metric (a value in [0,1], or null = "not measured").
// Validated on load so an empty/stale/typo'd baseline fails loud rather than
// silently green-gating a comparison that checks nothing.
const metric = z.number().min(0).max(1).nullable();
export const BaselineSchema = z.strictObject({
  filing_accuracy: metric,
  decision_band_accuracy: metric,
  no_clobber_rate: metric,
  contradiction_recall: metric,
  entity_resolution: metric,
});

export type Baseline = z.infer<typeof BaselineSchema>;

export interface Regression {
  metric: BaselineMetric;
  baseline: number;
  observed: number;
  delta: number;
}

export interface GateResult {
  passed: boolean;
  tolerance: number;
  regressions: Regression[];
}

/** The default slack allowed before a drop counts as a regression (real-model runs vary). */
export const DEFAULT_TOLERANCE = 0.05;

export function baselineFromReport(report: EvalReport): Baseline {
  return {
    filing_accuracy: report.filing_accuracy,
    decision_band_accuracy: report.decision_band_accuracy,
    no_clobber_rate: report.no_clobber_rate,
    contradiction_recall: report.contradiction_recall,
    entity_resolution: report.entity_resolution,
  };
}

export function compareToBaseline(
  report: EvalReport,
  baseline: Baseline,
  tolerance: number = DEFAULT_TOLERANCE,
): GateResult {
  const observed = baselineFromReport(report);
  const regressions: Regression[] = [];
  for (const metric of BASELINE_METRICS) {
    const base = baseline[metric];
    if (base === null || base === undefined) continue; // nothing expected of this metric
    const value = observed[metric];
    if (value === null) {
      regressions.push({ metric, baseline: base, observed: 0, delta: -base });
      continue;
    }
    const delta = value - base;
    if (delta < -tolerance) regressions.push({ metric, baseline: base, observed: value, delta });
  }
  return { passed: regressions.length === 0, tolerance, regressions };
}
