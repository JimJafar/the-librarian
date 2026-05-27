// Local-provider tests — drive the LocalInferenceClient with an
// in-memory fake. The real worker-backed client is exercised only
// behind the `LIBRARIAN_CLASSIFIER_LOCAL_E2E=1` integration flag.

import { describe, expect, it } from "vitest";
import { createClassifier, type LocalInferenceClient } from "../src/providers/index.js";

const INPUT = {
  title: "User prefers Vim",
  body: "User edits source files in Vim.",
  tags: ["tools"],
};

let clockMs = 1_000;
function fakeNow(): number {
  clockMs += 5;
  return clockMs;
}

function fakeInference(
  impl: (prompt: string, signal: AbortSignal) => Promise<string>,
): LocalInferenceClient {
  return { infer: impl };
}

describe("createClassifier — local", () => {
  it("classifies a valid JSON response from the local inference client", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "lfm2.5-1.2b-instruct" },
      {
        inferenceFor: () =>
          fakeInference(async (prompt) => {
            expect(prompt).toContain("TITLE: User prefers Vim");
            return '{"requires_approval": false, "is_global": false}';
          }),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: false, is_global: false });
    expect(result.fallback_used).toBeUndefined();
    expect(result.provider).toBe("local");
    expect(result.model).toBe("lfm2.5-1.2b-instruct");
    expect(result.prompt_version).toBe("v1");
    expect(result.raw_output).toBe('{"requires_approval": false, "is_global": false}');
  });

  it("strips a thinking preamble and reads the last JSON object", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "lfm2.5-1.2b-thinking" },
      {
        inferenceFor: () =>
          fakeInference(
            async () =>
              '<think>This is a preferences memory.</think>\n{"requires_approval": false, "is_global": true}',
          ),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: false, is_global: true });
    expect(result.fallback_used).toBeUndefined();
  });

  it("falls back to conservative defaults with fallback_used='parse' on malformed output", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "lfm2.5-1.2b-instruct" },
      {
        inferenceFor: () => fakeInference(async () => "I cannot answer that."),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: true, is_global: false });
    expect(result.fallback_used).toBe("parse");
    expect(result.provider).toBe("local");
  });

  it("maps an aborted inference to fallback_used='timeout'", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "lfm2.5-1.2b-instruct" },
      {
        inferenceFor: () =>
          fakeInference(
            (_prompt, signal) =>
              new Promise<string>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
              }),
          ),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT, { timeoutMs: 5 });
    expect(result.verdict).toEqual({ requires_approval: true, is_global: false });
    expect(result.fallback_used).toBe("timeout");
    expect(result.raw_output).toBe("");
  });

  it("maps an unexpected throw to fallback_used='provider_unavailable'", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "lfm2.5-1.2b-instruct" },
      {
        inferenceFor: () =>
          fakeInference(async () => {
            throw new Error("model OOM");
          }),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.fallback_used).toBe("provider_unavailable");
    expect(result.raw_output).toBe("");
  });

  it("propagates quant from config into the inferenceFor factory", async () => {
    let received: { modelId: string; quant?: string } | null = null;
    const classifier = createClassifier(
      { provider: "local", modelId: "phi-4-mini-instruct", quant: "Q8_0" },
      {
        inferenceFor: (cfg) => {
          received = cfg;
          return fakeInference(async () => '{"requires_approval": false, "is_global": false}');
        },
        now: fakeNow,
      },
    );
    await classifier.classify(INPUT);
    expect(received).toEqual({ modelId: "phi-4-mini-instruct", quant: "Q8_0" });
  });
});
