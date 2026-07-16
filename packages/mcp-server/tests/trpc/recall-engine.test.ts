// memories.recall must run the HYBRID engine — keyword + vector + backlink
// graph, RRF-fused — the SAME engine the recall MCP tool gives agents, not
// keyword-only store.searchMemories. Regression for the dashboard's Recall
// tab showing a different result set/order than agents actually get (spec
// 2026-06-19, Task 4). In-process caller (not the HTTP server) so the store can
// be spied.
//
// spec 065 T4 moved the procedure to the principal-scoped delegate: the spy
// target is now `recallForPrincipal` (062's surface — whose default-router path
// IS exactly the old hybrid store.recall, byte-identical). The test's intent is
// unchanged: the hybrid engine runs, the keyword-only path never does.

import { createLibrarianStore } from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";

const createCaller = createCallerFactory(appRouter);

function admin(store: unknown) {
  return createCaller({
    // spec 061 T3: TrpcContext now carries a required `principal`; the admin
    // principal is what `adminProcedure` gates on (roles), `role` is deprecated derived.
    principal: { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] },
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

  it("recalls via the hybrid recallForPrincipal, not keyword store.searchMemories", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({
        title: "Coffee preferences",
        body: "Espresso, no sugar.",
        agent_id: "bede",
      });
      const recallSpy = vi.spyOn(store, "recallForPrincipal");
      const keywordSpy = vi.spyOn(store, "searchMemories");

      const { memories } = await admin(store).memories.recall({ query: "coffee" });

      expect(recallSpy).toHaveBeenCalled(); // the hybrid engine, principal-scoped (spec 065 T4)
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
      const recallSpy = vi.spyOn(store, "recallForPrincipal");

      await admin(store).memories.recall({ query: "coffee", tags: ["drink"] });

      expect(recallSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tags: ["drink"] }),
      );
    } finally {
      store.close();
    }
  });
});
