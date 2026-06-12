// Unit tests for the pure scoring layer — scoreSample grades one plan against a
// fixture's ground truth, and summarize aggregates the sub-metrics with correct
// null handling (a metric with no applicable samples is null, not 0).

import { describe, expect, it } from "vitest";
import {
  type IntakeFixtureEntry,
  type SampleResult,
  scoreSample,
  summarize,
} from "../src/index.js";
import type { RoutedPlan } from "../src/metrics.js";

const augmentEntry: IntakeFixtureEntry = {
  id: "e_augment",
  scenario: "S2",
  category: "straight",
  submission: { text: "Anna mentored Sophie." },
  corpus: [{ id: "mem_anna", title: "Anna", body: "Anna is an engineer.", tags: [] }],
  expect: { action: "augment", decision: "apply", target_id: "mem_anna" },
};

const plan = (judgment: RoutedPlan["judgment"], decision: string) =>
  ({ judgment, decision }) as RoutedPlan;

describe("scoreSample", () => {
  it("credits a correct augment (action + decision + target)", () => {
    const result = scoreSample(
      augmentEntry,
      plan(
        {
          action: "augment",
          target_id: "mem_anna",
          addition: "Mentored Sophie.",
          rationale: "r",
          confidence: 0.99,
        },
        "apply",
      ),
    );
    expect(result.action_match).toBe(true);
    expect(result.decision_match).toBe(true);
    expect(result.target_match).toBe(true);
    expect(result.filed_correctly).toBe(true);
  });

  it("marks a wrong target as not filed correctly", () => {
    const result = scoreSample(
      augmentEntry,
      plan(
        {
          action: "augment",
          target_id: "mem_other",
          addition: "x",
          rationale: "r",
          confidence: 0.99,
        },
        "apply",
      ),
    );
    expect(result.action_match).toBe(true);
    expect(result.target_match).toBe(false);
    expect(result.filed_correctly).toBe(false);
  });

  it("leaves target_match null when no target is expected", () => {
    const createEntry: IntakeFixtureEntry = {
      ...augmentEntry,
      id: "e_create",
      scenario: "S1",
      expect: { action: "create", decision: "apply" },
    };
    const result = scoreSample(
      createEntry,
      plan(
        { action: "create", title: "T", body: "B", tags: [], rationale: "r", confidence: 0.99 },
        "apply",
      ),
    );
    expect(result.target_match).toBeNull();
    expect(result.filed_correctly).toBe(true);
  });

  it("records a parse failure as a total miss", () => {
    const result = scoreSample(augmentEntry, null, "bad json");
    expect(result.actual).toBeNull();
    expect(result.action_match).toBe(false);
    expect(result.filed_correctly).toBe(false);
    expect(result.parse_error).toBe("bad json");
  });

  it("does not grade the target on a grade_target:false entry (the target is an arbitrary tiebreak)", () => {
    const ambiguous: IntakeFixtureEntry = {
      ...augmentEntry,
      id: "e_ambiguous",
      scenario: "S12",
      expect: {
        action: "augment",
        decision: "propose",
        target_id: "mem_anna",
        grade_target: false,
      },
    };
    // A correct low-confidence augment that names the "wrong" doc — the proposal
    // discards the target, so it must not be docked on filing.
    const result = scoreSample(
      ambiguous,
      plan(
        {
          action: "augment",
          target_id: "mem_other",
          addition: "x",
          rationale: "r",
          confidence: 0.5,
        },
        "propose",
      ),
    );
    expect(result.target_match).toBeNull();
    expect(result.filed_correctly).toBe(true);
  });
});

describe("summarize", () => {
  const mk = (over: Partial<SampleResult>): SampleResult => ({
    id: "x",
    scenario: "S1",
    category: "straight",
    expected: { action: "create", decision: "apply" },
    actual: { action: "create", decision: "apply" },
    action_match: true,
    decision_match: true,
    target_match: null,
    no_clobber: null,
    filed_correctly: true,
    ...over,
  });

  it("returns null sub-metrics when no samples apply", () => {
    const report = summarize([mk({}), mk({ id: "y" })]);
    expect(report.no_clobber_rate).toBeNull();
    expect(report.contradiction_recall).toBeNull();
    expect(report.entity_resolution).toBeNull();
    expect(report.filing_accuracy).toBe(1);
  });

  it("computes contradiction_recall over S4 samples only", () => {
    const report = summarize([
      mk({ id: "a", scenario: "S4", actual: { action: "supersede", decision: "apply" } }),
      mk({ id: "b", scenario: "S4", actual: { action: "augment", decision: "apply" } }),
      mk({ id: "c", scenario: "S1" }), // ignored by the S4 metric
    ]);
    expect(report.contradiction_recall).toBe(0.5);
  });

  it("counts an ambiguous auto-augment as a failed entity resolution (S12)", () => {
    const report = summarize([
      mk({ id: "a", scenario: "S12", actual: { action: "augment", decision: "propose" } }), // avoided
      mk({ id: "b", scenario: "S12", actual: { action: "augment", decision: "apply" } }), // under-merged
    ]);
    expect(report.entity_resolution).toBe(0.5);
  });

  it("counts a confident wrong-supersede (and augment) as a failed entity resolution (S12)", () => {
    const report = summarize([
      mk({ id: "a", scenario: "S12", actual: { action: "supersede", decision: "apply" } }), // destructive
      mk({ id: "b", scenario: "S12", actual: { action: "augment", decision: "apply" } }), // destructive
      mk({ id: "c", scenario: "S12", actual: { action: "create", decision: "apply" } }), // safe: fresh doc
      mk({ id: "d", scenario: "S12", actual: { action: "supersede", decision: "propose" } }), // safe: not auto
    ]);
    expect(report.entity_resolution).toBe(0.5);
  });
});
