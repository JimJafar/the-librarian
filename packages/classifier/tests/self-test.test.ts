// runSelfTest is the gate the dashboard uses before saving a custom-
// model config. It only checks that the model produces parseable JSON
// — the verdict's content is irrelevant at this layer.

import { describe, expect, it } from "vitest";
import { createClassifier, type LocalInferenceClient } from "../src/providers/index.js";
import { runSelfTest } from "../src/self-test.js";

function fakeInference(impl: (prompt: string) => Promise<string>): LocalInferenceClient {
  return { infer: async (p) => impl(p) };
}

describe("runSelfTest", () => {
  it("returns ok=true when the model produces parseable JSON", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "lfm2.5-1.2b-instruct" },
      {
        inferenceFor: () =>
          fakeInference(async () => '{"requires_approval": true, "is_global": true}'),
      },
    );
    const result = await runSelfTest(classifier);
    expect(result.ok).toBe(true);
    expect(result.raw_output).toBe('{"requires_approval": true, "is_global": true}');
    expect(result.reason).toBeUndefined();
  });

  it("returns ok=false with the raw output when the model can't produce JSON", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "broken-model" },
      {
        inferenceFor: () => fakeInference(async () => "Sorry, I can't help with that."),
      },
    );
    const result = await runSelfTest(classifier);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("parse");
    expect(result.raw_output).toBe("Sorry, I can't help with that.");
  });

  it("returns ok=false on provider unavailability", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "broken-model" },
      {
        inferenceFor: () =>
          fakeInference(async () => {
            throw new Error("provider down");
          }),
      },
    );
    const result = await runSelfTest(classifier);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_unavailable");
  });
});
