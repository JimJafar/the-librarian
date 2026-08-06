import { createHash } from "node:crypto";
import type { ChronicleFacts, ChronicleNarrative } from "@librarian/core";
import { renderChronicle, writeChronicle } from "@librarian/core";
import { describe, expect, it, vi } from "vitest";

const FACTS: ChronicleFacts = {
  period: {
    start: "2026-07-27T00:00:00.000Z",
    end: "2026-08-03T00:00:00.000Z",
    isoWeek: "2026-W31",
    partial: false,
  },
  commits: {
    entries: [],
    bySource: { agent: 3, curator: 2 },
  },
  memories: {
    created: [
      {
        id: "mem-new",
        title: "Keep release notes factual",
        body: "Only claim what the checks prove.",
        status: "active",
        tags: ["release", "quality"],
        agentId: "agent-a",
        createdAt: "2026-07-28T09:00:00.000Z",
        updatedAt: "2026-07-28T09:00:00.000Z",
      },
    ],
    updated: [],
    archived: [],
    pendingProposals: 2,
  },
  handoffs: {
    created: [
      {
        id: "hdo-1",
        path: "handoffs/hdo-1.md",
        title: "Ship Chronicle",
        projectKey: "the-librarian",
        createdAt: "2026-07-29T09:00:00.000Z",
        claimedAt: "2026-07-29T09:30:00.000Z",
        createdByAgentId: "agent-a",
        createdInHarness: "codex",
      },
    ],
    claimed: [
      {
        id: "hdo-1",
        path: "handoffs/hdo-1.md",
        title: "Ship Chronicle",
        projectKey: "the-librarian",
        createdAt: "2026-07-29T09:00:00.000Z",
        claimedAt: "2026-07-29T09:30:00.000Z",
        latencySeconds: 1800,
        createdByAgentId: "agent-a",
        createdInHarness: "codex",
      },
    ],
    stillOpenOlder: [],
    openQuestions: [
      {
        handoffId: "hdo-1",
        path: "handoffs/hdo-1.md",
        markdown: "Should the first release stay opt-in?",
      },
    ],
  },
  runs: {
    curation: { statuses: { completed: 1 }, operations: { "update:applied": 2 } },
    intake: { statuses: { completed: 1 }, operations: { "create:applied": 1 } },
    tokenUsage: [
      {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 120,
        outputTokens: 30,
      },
    ],
    intakeTokenUsageAvailable: false,
  },
  warnings: ["Intake token usage is unavailable in the current run-log schema."],
};

const NARRATIVE: ChronicleNarrative = {
  headline: "Chronicle moved from a paper design into tested infrastructure.",
  narrativeMd: "The Librarian gained a deterministic weekly record grounded in vault facts.",
  blogSeeds: [
    {
      title: "Why a digest should survive its narrator",
      angle: "Treat generated prose as an enhancement over deterministic evidence.",
      sources: ["handoffs/hdo-1.md", "mem-new"],
    },
  ],
};

describe("renderChronicle", () => {
  it("renders a useful deterministic digest when no narrative is available", () => {
    const entry = renderChronicle(FACTS, undefined, {
      generatedAt: "2026-08-03T08:00:00.000Z",
    });

    expect(entry.path).toBe("references/chronicle/2026-W31.md");
    expect(entry.content).toContain("generated_at: 2026-08-03T08:00:00.000Z");
    expect(entry.content).toContain("5 vault commits, 1 memory filed, and 1 handoff created.");
    expect(entry.content).toContain("Keep release notes factual (`mem-new`)");
    expect(entry.content).toContain("Should the first release stay opt-in?");
    expect(entry.content).toContain("openai / gpt-5 | 120 | 30 | 150");
    expect(entry.content).toContain("Intake token usage is unavailable");
    expect(entry.content).not.toContain("## The week's story");
    expect(contentSnapshot(entry.content)).toBe(
      "c23b5640e2a4c53a4e09d5420e2e6eccfc926ce2c57ee17d86bc8f90a1f724f0",
    );
  });

  it("renders the narrated story and bounded blog seeds for a partial week", () => {
    const entry = renderChronicle(
      {
        ...FACTS,
        period: {
          ...FACTS.period,
          partial: true,
          end: "2026-07-30T00:30:00.000Z",
          throughDate: "2026-07-29",
        },
      },
      NARRATIVE,
      { generatedAt: "2026-07-30T12:00:00.000Z" },
    );

    expect(entry.content).toContain("# Chronicle: 2026-W31 (partial — through 2026-07-29)");
    expect(entry.content).toContain(NARRATIVE.headline);
    expect(entry.content).toContain("## The week's story");
    expect(entry.content).toContain(NARRATIVE.narrativeMd);
    expect(entry.content).toContain("### Why a digest should survive its narrator");
    expect(entry.content).toContain("Sources: `handoffs/hdo-1.md`, `mem-new`");
    expect(contentSnapshot(entry.content)).toBe(
      "fd8f4d9b4e96b9aa4e09fe3807991e27d8f9131be2201397f83d690505920bd3",
    );
  });

  it("defensively makes active model Markdown passive at the write boundary", () => {
    const entry = renderChronicle(FACTS, {
      headline: '<img src="https://attacker.example/headline">',
      narrativeMd: "![leak](https://attacker.example/private) [safe](https://example.com)",
      blogSeeds: [
        {
          title: "Hostile seed",
          angle: "<iframe src=https://attacker.example></iframe>",
          sources: ["mem-new"],
        },
      ],
    });

    expect(entry.content).not.toContain("![");
    expect(entry.content).not.toContain("<img");
    expect(entry.content).not.toContain("<iframe");
    expect(entry.content).toContain("&#33;[leak](https://attacker.example/private)");
    expect(entry.content).toContain("[safe](https://example.com)");
    expect(entry.content).toContain("&lt;iframe");
  });
});

/** Full-output golden: any changed byte in the rendered Markdown changes this digest. */
function contentSnapshot(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("writeChronicle", () => {
  it("upserts the rendered entry through the narrow Chronicle writer", () => {
    const upsert = vi.fn(() => ({ path: "references/chronicle/2026-W31.md" }));

    const result = writeChronicle(
      FACTS,
      NARRATIVE,
      { upsert },
      {
        generatedAt: "2026-08-03T08:00:00.000Z",
      },
    );

    expect(upsert).toHaveBeenCalledWith({
      isoWeek: "2026-W31",
      content: expect.stringContaining("Chronicle moved from a paper design"),
    });
    expect(result.path).toBe("references/chronicle/2026-W31.md");
  });
});
