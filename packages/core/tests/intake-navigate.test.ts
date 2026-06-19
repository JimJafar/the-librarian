// Intake navigate step (plan 036 Phase 4 / spec 035 §F5:
// "navigate (retrieve candidates + ToC map) → judge → edit"). For one inbox
// submission, navigate gathers the existing memories most relevant to it (the
// augment / update / supersede targets, via index recall) plus a bounded
// table-of-contents of the active corpus (the create/filing anchor). Pure
// orchestration over injected recall + listing — no LLM, no index internals.

import { type Memory, navigateInbox } from "@librarian/core";
import { describe, expect, it, vi } from "vitest";

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

describe("navigateInbox", () => {
  it("returns the recalled candidates and a compact ToC of the active corpus", async () => {
    const recalled = [mem({ id: "m1", title: "Anna" }), mem({ id: "m2", title: "Berlin" })];
    const active = [
      mem({ id: "m1", title: "Anna", tags: ["person"] }),
      mem({ id: "m2", title: "Berlin" }),
    ];
    const result = await navigateInbox("Anna moved to Berlin", {
      recall: async () => recalled,
      listActive: () => active,
    });

    expect(result.candidates.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.toc).toEqual([
      { id: "m1", title: "Anna", tags: ["person"] },
      { id: "m2", title: "Berlin", tags: [] },
    ]);
  });

  it("asks recall for candidateLimit candidates (default 8)", async () => {
    const recall = vi.fn(async () => []);
    await navigateInbox("x", { recall, listActive: () => [] });
    expect(recall).toHaveBeenCalledWith("x", 8);

    recall.mockClear();
    await navigateInbox("x", { recall, listActive: () => [] }, { candidateLimit: 3 });
    expect(recall).toHaveBeenCalledWith("x", 3);
  });

  it("bounds the ToC to tocLimit (highest-ranked listing order preserved)", async () => {
    const active = Array.from({ length: 10 }, (_, i) => mem({ id: `m${i}` }));
    const result = await navigateInbox(
      "q",
      { recall: async () => [], listActive: () => active },
      { tocLimit: 4 },
    );
    expect(result.toc.map((t) => t.id)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  it("returns an empty ToC for an empty corpus", async () => {
    const result = await navigateInbox("q", { recall: async () => [], listActive: () => [] });
    expect(result.toc).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("skips recall for an empty submission but still returns the ToC", async () => {
    const recall = vi.fn(async () => [mem({ id: "should-not-appear" })]);
    const result = await navigateInbox("   ", {
      recall,
      listActive: () => [mem({ id: "m1" })],
    });
    expect(recall).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.toc.map((t) => t.id)).toEqual(["m1"]);
  });
});
