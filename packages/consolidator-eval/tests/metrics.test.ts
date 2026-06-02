// Unit tests for the pure scoring layer — scoreSample grades one plan against a
// fixture's ground truth, and summarize aggregates the sub-metrics with correct
// null handling (a metric with no applicable samples is null, not 0).

import type { ConsolidationPlan } from "@librarian/core";
import { describe, expect, it } from "vitest";
import {
  type ConsolidatorFixtureEntry,
  type SampleResult,
  scoreSample,
  summarize,
} from "../src/index.js";

const augmentEntry: ConsolidatorFixtureEntry = {
  id: "e_augment",
  scenario: "S2",
  category: "straight",
  submission: { text: "Anna mentored Sophie." },
  corpus: [{ id: "mem_anna", title: "Anna", body: "Anna is an engineer.", tags: [] }],
  expect: { action: "augment", decision: "auto_apply", target_id: "mem_anna" },
};

const plan = (judgment: ConsolidationPlan["judgment"], decision: ConsolidationPlan["decision"]) =>
  ({ judgment, decision }) as ConsolidationPlan;

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
        "auto_apply",
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
        "auto_apply",
      ),
    );
    expect(result.action_match).toBe(true);
    expect(result.target_match).toBe(false);
    expect(result.filed_correctly).toBe(false);
  });

  it("leaves target_match null when no target is expected", () => {
    const createEntry: ConsolidatorFixtureEntry = {
      ...augmentEntry,
      id: "e_create",
      scenario: "S1",
      expect: { action: "create", decision: "auto_apply" },
    };
    const result = scoreSample(
      createEntry,
      plan(
        { action: "create", title: "T", body: "B", tags: [], rationale: "r", confidence: 0.99 },
        "auto_apply",
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
});

describe("summarize", () => {
  const mk = (over: Partial<SampleResult>): SampleResult => ({
    id: "x",
    scenario: "S1",
    category: "straight",
    expected: { action: "create", decision: "auto_apply" },
    actual: { action: "create", decision: "auto_apply" },
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
      mk({ id: "a", scenario: "S4", actual: { action: "supersede", decision: "auto_apply" } }),
      mk({ id: "b", scenario: "S4", actual: { action: "augment", decision: "auto_apply" } }),
      mk({ id: "c", scenario: "S1" }), // ignored by the S4 metric
    ]);
    expect(report.contradiction_recall).toBe(0.5);
  });

  it("counts an ambiguous auto-augment as a failed entity resolution (S12)", () => {
    const report = summarize([
      mk({ id: "a", scenario: "S12", actual: { action: "augment", decision: "create_new" } }), // avoided
      mk({ id: "b", scenario: "S12", actual: { action: "augment", decision: "auto_apply" } }), // under-merged
    ]);
    expect(report.entity_resolution).toBe(0.5);
  });
});
