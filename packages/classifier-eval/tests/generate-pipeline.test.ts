// Pipeline orchestrator tests — runs against in-memory stub clients
// so the full generate → grade → consensus → trim → iterate loop is
// exercised without any HTTP.

import { describe, expect, it } from "vitest";
import { parseGeneratorOutput, runFixtureGenerator } from "../src/generate/pipeline.js";
import type { PipelineClients } from "../src/generate/pipeline.js";
import type { PipelineConfig } from "../src/generate/types.js";

const CONFIG: PipelineConfig = {
  generator: {
    name: "claude-sonnet",
    endpoint: "https://example/v1",
    model: "claude-sonnet-x",
    token_env: "_T",
  },
  graders: [
    { name: "claude", endpoint: "https://a/v1", model: "claude", token_env: "_T" },
    { name: "gpt", endpoint: "https://b/v1", model: "gpt", token_env: "_T" },
    { name: "gemini", endpoint: "https://c/v1", model: "gemini", token_env: "_T" },
  ],
};

function candidateJson(
  category: "straight" | "boundary",
  label: { requires_approval: boolean; is_global: boolean },
  i: number,
): string {
  return JSON.stringify({
    title: `title-${category}-${i}`,
    body: `body-${category}-${i}`,
    tags: ["x"],
    label,
    category,
  });
}

function batch(items: string[]): string {
  return `[${items.join(",")}]`;
}

function unanimousAgree(label: { requires_approval: boolean; is_global: boolean }): string {
  return JSON.stringify(label);
}

describe("runFixtureGenerator", () => {
  it("returns the requested ratio when graders unanimously agree", async () => {
    const labels = [
      { requires_approval: true, is_global: true },
      { requires_approval: false, is_global: false },
    ];
    // Track per-candidate so all 3 graders of one candidate see the
    // same verdict (unanimity is what the consensus filter accepts).
    let candidateIdx = -1;
    let lastGraderForCandidate = -1;
    const clients: PipelineClients = {
      async generate() {
        const cands = [
          candidateJson("straight", labels[0]!, 1),
          candidateJson("straight", labels[1]!, 2),
          candidateJson("straight", labels[0]!, 3),
          candidateJson("boundary", labels[1]!, 4),
          candidateJson("boundary", labels[0]!, 5),
        ];
        return batch(cands);
      },
      async grade(graderIndex) {
        // The pipeline calls grader 0, then 1, then 2 in order per
        // candidate. Roll the candidate index forward when grader 0
        // is hit (start of a new candidate).
        if (graderIndex <= lastGraderForCandidate) candidateIdx++;
        else if (graderIndex === 0) candidateIdx++;
        lastGraderForCandidate = graderIndex;
        return unanimousAgree(labels[candidateIdx % labels.length]!);
      },
    };
    const result = await runFixtureGenerator(clients, {
      config: CONFIG,
      targets: { total: 5, boundaryRatio: 0.4 },
      budget: { maxCalls: 100 },
      candidatesPerBatch: 5,
      maxIterations: 3,
    });
    expect(result.fixture).toHaveLength(5);
    const straightCount = result.fixture.filter((e) => e.category === "straight").length;
    const boundaryCount = result.fixture.filter((e) => e.category === "boundary").length;
    expect(straightCount).toBe(3);
    expect(boundaryCount).toBe(2);
    // consensus_models flows through every survivor
    for (const e of result.fixture) {
      expect(e.consensus_models).toEqual(["claude", "gpt", "gemini"]);
    }
  });

  it("drops candidates when any grader disagrees", async () => {
    const calls: string[] = [];
    const clients: PipelineClients = {
      async generate() {
        return batch([
          candidateJson("straight", { requires_approval: true, is_global: true }, 1),
          candidateJson("straight", { requires_approval: false, is_global: false }, 2),
        ]);
      },
      async grade(graderIndex) {
        calls.push(`g${graderIndex}`);
        // grader 0 + 1 say (T,T), grader 2 says (T,F) → disagreement
        if (graderIndex === 2) {
          return '{"requires_approval": true, "is_global": false}';
        }
        return '{"requires_approval": true, "is_global": true}';
      },
    };
    await expect(
      runFixtureGenerator(clients, {
        config: CONFIG,
        targets: { total: 2, boundaryRatio: 0 },
        budget: { maxCalls: 100 },
        candidatesPerBatch: 2,
        maxIterations: 2,
      }),
    ).rejects.toThrow(/iteration cap reached/);
    // 3 graders × 2 candidates × 2 iterations = 12 grader calls + 2 generator
    expect(calls.length).toBeGreaterThan(0);
  });

  it("uses the graders' consensus as the ground-truth label even when the generator claimed something else", async () => {
    const clients: PipelineClients = {
      async generate() {
        return batch([candidateJson("straight", { requires_approval: true, is_global: true }, 1)]);
      },
      async grade() {
        // Graders unanimous on (F, F) — overrides the generator's (T, T).
        return '{"requires_approval": false, "is_global": false}';
      },
    };
    const result = await runFixtureGenerator(clients, {
      config: CONFIG,
      targets: { total: 1, boundaryRatio: 0 },
      budget: { maxCalls: 100 },
      candidatesPerBatch: 1,
      maxIterations: 3,
    });
    expect(result.fixture[0]!.label).toEqual({ requires_approval: false, is_global: false });
  });

  it("throws when the call budget is exhausted before targets are met", async () => {
    // Deterministic disagreement: grader 2 always votes the opposite
    // of graders 0 + 1, so no candidate ever survives the unanimous
    // filter. The pipeline keeps iterating, the budget runs out.
    const clients: PipelineClients = {
      async generate() {
        return batch([candidateJson("straight", { requires_approval: true, is_global: true }, 1)]);
      },
      async grade(graderIndex) {
        return graderIndex === 2
          ? '{"requires_approval": false, "is_global": false}'
          : '{"requires_approval": true, "is_global": true}';
      },
    };
    await expect(
      runFixtureGenerator(clients, {
        config: CONFIG,
        targets: { total: 1, boundaryRatio: 0 },
        budget: { maxCalls: 5 },
        candidatesPerBatch: 1,
        maxIterations: 10,
      }),
    ).rejects.toThrow(/budget exhausted/);
  });
});

describe("parseGeneratorOutput", () => {
  it("parses a bare JSON array", () => {
    const out = parseGeneratorOutput(
      batch([candidateJson("straight", { requires_approval: false, is_global: false }, 1)]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.category).toBe("straight");
  });

  it("tolerates a code-fence wrapper", () => {
    const cand = candidateJson("boundary", { requires_approval: true, is_global: true }, 1);
    const wrapped = `Here is the batch:\n\n\`\`\`json\n[${cand}]\n\`\`\`\n`;
    const out = parseGeneratorOutput(wrapped);
    expect(out).toHaveLength(1);
  });

  it("returns [] on malformed JSON", () => {
    expect(parseGeneratorOutput("not json")).toEqual([]);
    expect(parseGeneratorOutput("[")).toEqual([]);
  });

  it("drops malformed candidates inside an otherwise-valid array", () => {
    const good = candidateJson("straight", { requires_approval: false, is_global: false }, 1);
    const bad = JSON.stringify({ title: "missing body" });
    const out = parseGeneratorOutput(`[${good}, ${bad}]`);
    expect(out).toHaveLength(1);
  });
});
