// Curator LLM-usage aggregation for the analytics page.

import { describe, expect, it } from "vitest";
import { summariseCuratorUsage } from "@/components/analytics/usage";

describe("summariseCuratorUsage", () => {
  it("sums input/output tokens and counts completed runs", () => {
    const u = summariseCuratorUsage([
      {
        status: "completed",
        model_name: "deepseek-v4-flash",
        usage_input_tokens: 100,
        usage_output_tokens: 40,
      },
      {
        status: "completed",
        model_name: "deepseek-v4-flash",
        usage_input_tokens: 60,
        usage_output_tokens: 10,
      },
      {
        status: "skipped",
        model_name: "deepseek-v4-flash",
        usage_input_tokens: 0,
        usage_output_tokens: 0,
      },
    ]);
    expect(u.runs).toBe(3);
    expect(u.completed).toBe(2);
    expect(u.inputTokens).toBe(160);
    expect(u.outputTokens).toBe(50);
    expect(u.totalTokens).toBe(210);
  });

  it("groups token spend by model, largest first", () => {
    const u = summariseCuratorUsage([
      {
        status: "completed",
        model_name: "big-model",
        usage_input_tokens: 500,
        usage_output_tokens: 500,
      },
      {
        status: "completed",
        model_name: "small-model",
        usage_input_tokens: 10,
        usage_output_tokens: 5,
      },
      {
        status: "completed",
        model_name: "big-model",
        usage_input_tokens: 100,
        usage_output_tokens: 0,
      },
    ]);
    expect(u.byModel).toEqual([
      { model: "big-model", tokens: 1100, runs: 2 },
      { model: "small-model", tokens: 15, runs: 1 },
    ]);
  });

  it("tolerates missing token fields and blank model names", () => {
    const u = summariseCuratorUsage([
      { status: "failed" },
      { status: "completed", model_name: "  ", usage_input_tokens: 7 },
    ]);
    expect(u.inputTokens).toBe(7);
    expect(u.outputTokens).toBe(0);
    expect(u.byModel).toEqual([{ model: "unknown", tokens: 7, runs: 2 }]);
  });

  it("is all-zeros for an empty run list", () => {
    expect(summariseCuratorUsage([])).toEqual({
      runs: 0,
      completed: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      byModel: [],
    });
  });
});
