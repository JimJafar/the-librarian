// Remote-provider classify() tests — every error path collapses to a
// conservative-defaults verdict with a fallback_used flag. The LLM
// client is mocked end-to-end; no network.

import { LlmClientError, type LlmClient, type LlmCompletion } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClassifier, LOCAL_STUB_FLAG } from "../src/providers/index.js";

function fakeLlm(
  impl: (req: {
    messages: { role: string; content: string }[];
    timeoutMs?: number;
  }) => Promise<LlmCompletion>,
): LlmClient {
  return {
    complete: impl as LlmClient["complete"],
  };
}

const INPUT = {
  title: "User's name is Jim",
  body: "User goes by Jim.",
  tags: ["identity"],
};

let clockMs = 1_000;
function fakeNow(): number {
  clockMs += 7;
  return clockMs;
}

describe("createClassifier — remote", () => {
  it("classifies a valid JSON-line response", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async (req) => {
          // The prompt sends the rendered template as a user message.
          expect(req.messages[0]?.role).toBe("user");
          expect(req.messages[0]?.content).toContain("TITLE: User's name is Jim");
          return {
            content: '{"requires_approval": true, "is_global": true}',
            model: "gpt-4o-mini",
            usage: null,
          };
        }),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: true, is_global: true });
    expect(result.fallback_used).toBeUndefined();
    expect(result.provider).toBe("remote");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.prompt_version).toBe("v1");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.raw_output).toBe('{"requires_approval": true, "is_global": true}');
  });

  it("strips a CoT preamble and reads the last object", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async () => ({
          content: 'Reasoning: this is identity.\n\n{"requires_approval": true, "is_global": true}',
          model: "gpt-4o-mini",
          usage: null,
        })),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: true, is_global: true });
    expect(result.fallback_used).toBeUndefined();
  });

  it("falls back to conservative defaults with fallback_used='parse' on malformed JSON", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async () => ({
          content: "I'm sorry, I cannot classify this.",
          model: "gpt-4o-mini",
          usage: null,
        })),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: true, is_global: false });
    expect(result.fallback_used).toBe("parse");
    expect(result.provider).toBe("remote");
  });

  it("maps LlmClientError(kind=timeout) to fallback_used='timeout'", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async () => {
          throw new LlmClientError("timeout", "request timed out after 30000ms");
        }),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: true, is_global: false });
    expect(result.fallback_used).toBe("timeout");
  });

  it("maps LlmClientError(kind=http) to fallback_used='provider_unavailable'", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async () => {
          throw new LlmClientError("http", "HTTP 500", 500);
        }),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: true, is_global: false });
    expect(result.fallback_used).toBe("provider_unavailable");
  });

  it("maps an unexpected throw to fallback_used='provider_unavailable'", async () => {
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async () => {
          throw new Error("surprise");
        }),
        now: fakeNow,
      },
    );
    const result = await classifier.classify(INPUT);
    expect(result.fallback_used).toBe("provider_unavailable");
  });

  it("propagates the requested timeoutMs to the LLM client", async () => {
    let receivedTimeout: number | undefined;
    const classifier = createClassifier(
      { provider: "remote", modelId: "gpt-4o-mini" },
      {
        llm: fakeLlm(async (req) => {
          receivedTimeout = req.timeoutMs;
          return {
            content: '{"requires_approval": false, "is_global": false}',
            model: "gpt-4o-mini",
            usage: null,
          };
        }),
        now: fakeNow,
      },
    );
    await classifier.classify(INPUT, { timeoutMs: 5000 });
    expect(receivedTimeout).toBe(5000);
  });
});

describe("createClassifier — local stub (until 4b)", () => {
  const originalFlag = process.env[LOCAL_STUB_FLAG];
  beforeEach(() => {
    process.env[LOCAL_STUB_FLAG] = "1";
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env[LOCAL_STUB_FLAG];
    else process.env[LOCAL_STUB_FLAG] = originalFlag;
  });

  it("returns a provider_unavailable fallback so callers don't crash", async () => {
    const classifier = createClassifier(
      { provider: "local", modelId: "LFM2.5-1.2B-Instruct" },
      { llm: fakeLlm(async () => ({ content: "", model: "", usage: null })), now: fakeNow },
    );
    const result = await classifier.classify(INPUT);
    expect(result.verdict).toEqual({ requires_approval: true, is_global: false });
    expect(result.fallback_used).toBe("provider_unavailable");
    expect(result.provider).toBe("none");
    expect(result.raw_output).toBe("");
  });

  it("throws at construction when LIBRARIAN_CLASSIFIER_LOCAL_STUB is not set", () => {
    delete process.env[LOCAL_STUB_FLAG];
    expect(() =>
      createClassifier(
        { provider: "local", modelId: "LFM2.5-1.2B-Instruct" },
        { llm: fakeLlm(async () => ({ content: "", model: "", usage: null })), now: fakeNow },
      ),
    ).toThrow(/local classifier provider is not yet implemented/i);
  });
});
