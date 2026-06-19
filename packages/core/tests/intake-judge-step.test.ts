// Intake judge step (plan 036 Phase 4 / spec 035 §F5). The LLM half of
// the judge: prompt (the unified curator prompt, intake mode — structure
// pinned in curator-prompt.test.ts) → injected LLM → parse. Pairs with the
// pure judge layer (schema/parse, already tested); the apply layer's D13 rule
// owns routing. Uses a fake LlmClient — no network.

import {
  type IntakeCandidates,
  type LlmClient,
  type Memory,
  judgeSubmission,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    agent_id: "agent-a",
    title: `title ${over.id}`,
    body: "body",
    status: "active",
    confidence: "working",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    is_global: false,
    requires_approval: false,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

const evidence: IntakeCandidates = {
  candidates: [mem({ id: "mem_anna", title: "Anna", body: "Anna lives in Paris." })],
  toc: [{ id: "mem_anna", title: "Anna", tags: ["person"] }],
};

function fakeClient(content: string): LlmClient {
  return {
    complete: async () => ({ content, model: "gpt-x", usage: null }),
  };
}

describe("judgeSubmission", () => {
  it("returns the parsed judgment for a well-formed model response", async () => {
    const client = fakeClient(
      JSON.stringify({
        action: "augment",
        target_id: "mem_anna",
        addition: "She now lives in [[Berlin]].",
        rationale: "adds the move",
        confidence: 0.97,
      }),
    );
    const result = await judgeSubmission(
      { submissionText: "Anna moved to Berlin", evidence },
      { llmClient: client },
    );
    expect(result.parseError).toBeUndefined();
    expect(result.judgment).toMatchObject({ action: "augment", target_id: "mem_anna" });
  });

  it("sends the submission + evidence to the model (the prompt embeds them verbatim)", async () => {
    let seen = "";
    const client: LlmClient = {
      complete: async (request) => {
        seen = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({ action: "noop", rationale: "r", confidence: 0.9 }),
          model: "gpt-x",
          usage: null,
        };
      },
    };
    await judgeSubmission(
      { submissionText: "Anna moved to Berlin", evidence },
      { llmClient: client },
    );
    expect(seen).toContain("Anna moved to Berlin");
    expect(seen).toContain("mem_anna");
  });

  it("parses a model-emitted split through to the judgment (routing is the apply layer's D13 rule)", async () => {
    const client = fakeClient(
      JSON.stringify({
        action: "split",
        target_id: "mem_anna",
        replacements: [
          { title: "Anna — Person", body: "Anna lives in Paris." },
          { title: "Anna — Cafe", body: "The Anna cafe on Rue X." },
        ],
        rationale: "the doc conflates the person and the cafe",
        confidence: 0.99,
      }),
    );
    const result = await judgeSubmission(
      { submissionText: "The Anna cafe reopened.", evidence },
      { llmClient: client },
    );
    expect(result.parseError).toBeUndefined();
    expect(result.judgment).toMatchObject({ action: "split", target_id: "mem_anna" });
  });

  it("surfaces a parse error (and no judgment) when the model returns garbage", async () => {
    const result = await judgeSubmission(
      { submissionText: "x", evidence },
      { llmClient: fakeClient("not json at all") },
    );
    expect(result.judgment).toBeUndefined();
    expect(result.parseError).toBeTruthy();
  });
});
