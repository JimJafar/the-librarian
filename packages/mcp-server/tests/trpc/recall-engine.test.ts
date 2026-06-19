// memories.recall must run the HYBRID engine (store.recall — keyword + vector +
// backlink graph, RRF-fused), the SAME engine the recall MCP tool gives agents
// — not keyword-only store.searchMemories. Regression for the dashboard's Recall
// tab showing a different result set/order than agents actually get (spec
// 2026-06-19, Task 4). In-process caller (not the HTTP server) so the store can
// be spied.

import { createLibrarianStore } from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";

const createCaller = createCallerFactory(appRouter);

function admin(store: unknown) {
  return createCaller({
    role: "admin",
    store: store as never,
    secretKey: null,
    adminToken: "admin-token",
  });
}

describe("memories.recall engine (spec 2026-06-19 Task 4)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("recalls via the hybrid store.recall, not keyword store.searchMemories", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({
        title: "Coffee preferences",
        body: "Espresso, no sugar.",
        agent_id: "bede",
      });
      const recallSpy = vi.spyOn(store, "recall");
      const keywordSpy = vi.spyOn(store, "searchMemories");

      const { memories } = await admin(store).memories.recall({ query: "coffee" });

      expect(recallSpy).toHaveBeenCalled(); // the hybrid engine
      expect(keywordSpy).not.toHaveBeenCalled(); // NOT the keyword-only path
      expect(memories.some((m) => m.title === "Coffee preferences")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("forwards a tags filter to the hybrid recall", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({
        title: "Coffee",
        body: "Espresso.",
        agent_id: "bede",
        tags: ["drink"],
      });
      const recallSpy = vi.spyOn(store, "recall");

      await admin(store).memories.recall({ query: "coffee", tags: ["drink"] });

      expect(recallSpy).toHaveBeenCalledWith(expect.objectContaining({ tags: ["drink"] }));
    } finally {
      store.close();
    }
  });
});
