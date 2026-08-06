import type { ChronicleFacts, LlmClient } from "@librarian/core";
import { narrateChronicle } from "@librarian/core";
import { describe, expect, it, vi } from "vitest";

function facts(body = "A durable fact"): ChronicleFacts {
  return {
    period: {
      start: "2026-07-27T00:00:00.000Z",
      end: "2026-08-03T00:00:00.000Z",
      isoWeek: "2026-W31",
      partial: false,
    },
    commits: { entries: [], bySource: { agent: 1 } },
    memories: {
      created: [
        {
          id: "mem-1",
          title: "A decision",
          body,
          status: "active",
          tags: [],
          agentId: "agent-a",
          createdAt: "2026-07-28T09:00:00.000Z",
          updatedAt: "2026-07-28T09:00:00.000Z",
        },
      ],
      updated: [],
      archived: [],
      pendingProposals: 0,
    },
    handoffs: { created: [], claimed: [], stillOpenOlder: [], openQuestions: [] },
    runs: {
      curation: { statuses: {}, operations: {} },
      intake: { statuses: {}, operations: {} },
      tokenUsage: [],
      intakeTokenUsageAvailable: false,
    },
    warnings: [],
  };
}

function client(content: string): LlmClient {
  return {
    complete: vi.fn().mockResolvedValue({
      content,
      model: "narrator-model",
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    }),
  };
}

describe("narrateChronicle", () => {
  it("redacts the complete facts before bounding the prompt and returns validated narrative", async () => {
    const secretPrefix = "cutoff-leak";
    const secret = `${secretPrefix}${"A".repeat(1_000)}`;
    const llm = client(
      JSON.stringify({
        headline: "The week became legible.",
        narrative_md: "Work moved from loose evidence into a durable weekly record.",
        blog_seeds: [
          { title: "A durable digest", angle: "Why evidence comes first", sources: ["mem-1"] },
        ],
      }),
    );

    const result = await narrateChronicle(
      facts(`${"x".repeat(79_400)} api_key = "${secret}"`),
      llm,
    );

    const request = vi.mocked(llm.complete).mock.calls[0]?.[0];
    const prompt = request?.messages.at(-1)?.content ?? "";
    expect(prompt).not.toContain(secretPrefix);
    expect(prompt).toContain("[REDACTED:secret]");
    expect(prompt.length).toBeLessThan(81_000);
    expect(result).toMatchObject({
      status: "generated",
      model: "narrator-model",
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      narrative: {
        headline: "The week became legible.",
        blogSeeds: [{ title: "A durable digest", sources: ["mem-1"] }],
      },
    });
  });

  it("fails soft on malformed model output", async () => {
    await expect(
      narrateChronicle(facts(), client('{"headline":"missing fields"}')),
    ).resolves.toEqual(
      expect.objectContaining({ status: "failed", narrative: null, error: "malformed_output" }),
    );
  });

  it("fails soft when the provider call throws", async () => {
    const llm: LlmClient = {
      complete: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };

    await expect(narrateChronicle(facts(), llm)).resolves.toEqual(
      expect.objectContaining({ status: "failed", narrative: null, error: "llm_error" }),
    );
  });
});
