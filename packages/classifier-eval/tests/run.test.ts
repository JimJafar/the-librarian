// runEval drives a classifier through a fixture sample and emits a
// deterministic report. Tests use a mocked classifier so the harness
// is exercised end-to-end without any model dependency.

import type { Classifier, ClassifyResult } from "@librarian/classifier";
import { describe, expect, it } from "vitest";
import type { FixtureEntry } from "../src/fixture.js";
import { runEval } from "../src/run.js";

const FIXTURE: FixtureEntry[] = [
  {
    id: "fix_a",
    title: "A",
    body: "Identity fact.",
    tags: ["identity"],
    label: { requires_approval: true, is_global: true },
    category: "straight",
  },
  {
    id: "fix_b",
    title: "B",
    body: "Tool note.",
    tags: ["tools"],
    label: { requires_approval: false, is_global: false },
    category: "straight",
  },
  {
    id: "fix_c",
    title: "C",
    body: "Boundary case.",
    tags: ["people"],
    label: { requires_approval: true, is_global: false },
    category: "boundary",
  },
  {
    id: "fix_d",
    title: "D",
    body: "Another boundary.",
    tags: ["preferences"],
    label: { requires_approval: false, is_global: true },
    category: "boundary",
  },
];

function fakeClassifier(verdicts: Record<string, ClassifyResult>): Classifier {
  return {
    async classify(input) {
      const verdict = verdicts[input.title];
      if (!verdict) {
        throw new Error(`no fixture mapping for title=${input.title}`);
      }
      return verdict;
    },
  };
}

function classifyOk(requires_approval: boolean, is_global: boolean, latency = 100): ClassifyResult {
  return {
    verdict: { requires_approval, is_global },
    prompt_version: "v1",
    provider: "remote",
    model: "test-model",
    latency_ms: latency,
    raw_output: `{"requires_approval": ${requires_approval}, "is_global": ${is_global}}`,
  };
}

function classifyFallback(latency = 100): ClassifyResult {
  return {
    verdict: { requires_approval: true, is_global: false },
    fallback_used: "parse",
    prompt_version: "v1",
    provider: "remote",
    model: "test-model",
    latency_ms: latency,
    raw_output: "I can't classify this.",
  };
}

// Deterministic random source — returns the same sequence on every run.
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe("runEval", () => {
  it("reports joint agreement against fixture labels", async () => {
    const classifier = fakeClassifier({
      A: classifyOk(true, true),
      B: classifyOk(false, false),
      C: classifyOk(true, false),
      D: classifyOk(false, true),
    });
    const report = await runEval(classifier, {
      fixture: FIXTURE,
      sample: 4,
      category: "all",
    });
    expect(report.sample_size).toBe(4);
    expect(report.agreement.joint).toBe(1);
    expect(report.agreement.requires_approval).toBe(1);
    expect(report.agreement.is_global).toBe(1);
    expect(report.provider).toBe("remote");
    expect(report.model).toBe("test-model");
    expect(report.prompt_version).toBe("v1");
  });

  it("counts per-category disagreement separately", async () => {
    const classifier = fakeClassifier({
      A: classifyOk(true, true), // straight, agrees
      B: classifyOk(true, true), // straight, disagrees (expected false/false)
      C: classifyOk(true, false), // boundary, agrees
      D: classifyOk(true, false), // boundary, disagrees (expected false/true)
    });
    const report = await runEval(classifier, {
      fixture: FIXTURE,
      sample: 4,
      category: "all",
    });
    expect(report.disagreement_by_category.straight).toEqual({ total: 2, misses: 1 });
    expect(report.disagreement_by_category.boundary).toEqual({ total: 2, misses: 1 });
  });

  it("filters by category", async () => {
    const classifier = fakeClassifier({
      C: classifyOk(true, false),
      D: classifyOk(false, true),
    });
    const report = await runEval(classifier, {
      fixture: FIXTURE,
      sample: 4,
      category: "boundary",
    });
    expect(report.sample_size).toBe(2);
    expect(report.disagreement_by_category.straight.total).toBe(0);
    expect(report.disagreement_by_category.boundary.total).toBe(2);
  });

  it("returns a deterministic sample under a seeded random source", async () => {
    const verdicts: Record<string, ClassifyResult> = {
      A: classifyOk(true, true),
      B: classifyOk(false, false),
      C: classifyOk(true, false),
      D: classifyOk(false, true),
    };
    const r1 = await runEval(fakeClassifier(verdicts), {
      fixture: FIXTURE,
      sample: 2,
      category: "all",
      random: seededRandom(42),
    });
    const r2 = await runEval(fakeClassifier(verdicts), {
      fixture: FIXTURE,
      sample: 2,
      category: "all",
      random: seededRandom(42),
    });
    expect(r1.samples.map((s) => s.fixture_id)).toEqual(r2.samples.map((s) => s.fixture_id));
  });

  it("reports fallback counts on classifier failure", async () => {
    const classifier = fakeClassifier({
      A: classifyFallback(),
      B: classifyOk(false, false),
      C: classifyFallback(),
      D: classifyOk(false, true),
    });
    const report = await runEval(classifier, {
      fixture: FIXTURE,
      sample: 4,
      category: "all",
    });
    expect(report.fallback_counts.parse).toBe(2);
  });

  it("computes a latency distribution from sample observations", async () => {
    const classifier = fakeClassifier({
      A: classifyOk(true, true, 50),
      B: classifyOk(false, false, 100),
      C: classifyOk(true, false, 250),
      D: classifyOk(false, true, 800),
    });
    const report = await runEval(classifier, {
      fixture: FIXTURE,
      sample: 4,
      category: "all",
    });
    expect(report.latency_ms.max).toBe(800);
    expect(report.latency_ms.p50).toBeGreaterThanOrEqual(50);
    expect(report.latency_ms.p99).toBe(800);
  });
});
