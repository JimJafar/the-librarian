// runSelfTest is the gate the dashboard uses before saving a config. It
// only checks that the model produces parseable JSON — the verdict's
// content is irrelevant at this layer.

import type { LlmClient, LlmCompletion } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { createClassifier } from "../src/providers/index.js";
import { runSelfTest } from "../src/self-test.js";

function fakeLlm(impl: () => Promise<LlmCompletion>): LlmClient {
  return { complete: impl as LlmClient["complete"] };
}

describe("runSelfTest", () => {
  it("returns ok=true when the model produces parseable JSON", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async () => ({
          content: '{"requires_approval": true, "is_global": true}',
          model: "gpt-4o-mini",
          usage: null,
        })),
      },
    );
    const result = await runSelfTest(classifier);
    expect(result.ok).toBe(true);
    expect(result.raw_output).toBe('{"requires_approval": true, "is_global": true}');
    expect(result.reason).toBeUndefined();
  });

  it("returns ok=false with the raw output when the model can't produce JSON", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "broken-model" },
      {
        llm: fakeLlm(async () => ({
          content: "Sorry, I can't help with that.",
          model: "broken-model",
          usage: null,
        })),
      },
    );
    const result = await runSelfTest(classifier);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("parse");
    expect(result.raw_output).toBe("Sorry, I can't help with that.");
  });

  it("returns ok=false on provider unavailability", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "broken-model" },
      {
        llm: fakeLlm(async () => {
          throw new Error("provider down");
        }),
      },
    );
    const result = await runSelfTest(classifier);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_unavailable");
  });
});
