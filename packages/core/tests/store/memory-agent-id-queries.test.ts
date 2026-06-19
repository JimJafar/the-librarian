// MemoryStore agent-id query methods (F0 — seal the seam).
//
// caller-backfill reattributes stored caller ids; it needs to (a) count
// memories per agent and (b) list the memory ids for one agent. These were raw
// SELECTs against `store.db`; the store now owns them so backfill never reaches
// past the interface. Pins the grouping/listing contract directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Inferred type keeps `db`-free public API parity while this storage-layer test
// constructs the store directly (survives the PR-6 public/internal split).
let store: ReturnType<typeof createLibrarianStore> | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-agentid-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

function seed(agent_id: string, title: string): string {
  return store!.createMemory({
    agent_id,
    title,
    body: "body text",
    visibility: "common",
    confidence: "working",
  }).memory.id;
}

describe("MemoryStore — agent-id queries (caller-backfill seam)", () => {
  it("countMemoriesByAgentId groups counts per agent", () => {
    seed("claude-code", "a");
    seed("claude-code", "b");
    seed("codex", "c");

    const counts = store!.countMemoriesByAgentId();
    expect(counts.find((c) => c.agent_id === "claude-code")?.count).toBe(2);
    expect(counts.find((c) => c.agent_id === "codex")?.count).toBe(1);
  });

  it("listMemoryIdsByAgentId returns exactly the ids for one agent", () => {
    const a1 = seed("claude-code", "a");
    const a2 = seed("claude-code", "b");
    seed("codex", "c");

    expect(store!.listMemoryIdsByAgentId("claude-code").sort()).toEqual([a1, a2].sort());
    expect(store!.listMemoryIdsByAgentId("codex")).toHaveLength(1);
    expect(store!.listMemoryIdsByAgentId("nobody")).toEqual([]);
  });
});
