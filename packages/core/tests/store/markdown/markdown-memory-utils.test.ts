// Markdown MemoryStore — recordRecall / bulkUpdateMemory / distinctValues /
// countMemoriesByAgentId / listMemoryIdsByAgentId (plan 036 Phase 2): the
// utility verbs of the store contract.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Memory,
  createMarkdownMemoryStore,
  createVault,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-utils-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const vault = createVault({ dataDir });
  const store = createMarkdownMemoryStore({ vault, now: () => "2026-07-01T00:00:00.000Z" });
  const seed = (over: Partial<Memory> & { id: string }): Memory => {
    const memory: Memory = {
      id: over.id,
      title: over.title ?? over.id,
      body: "body",
      agent_id: over.agent_id ?? "codex",
      priority: "normal",
      confidence: "working",
      tags: [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      status: over.status ?? "active",
      is_global: false,
      requires_approval: false,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      curator_note: null,
    };
    vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
    return memory;
  };
  return { vault, store, seed };
}

describe("markdown MemoryStore — agent-id queries", () => {
  it("countMemoriesByAgentId groups counts per agent", () => {
    const { store, seed } = setup();
    seed({ id: "a", agent_id: "claude" });
    seed({ id: "b", agent_id: "claude" });
    seed({ id: "c", agent_id: "codex" });
    const counts = store.countMemoriesByAgentId();
    expect(counts.find((c) => c.agent_id === "claude")!.count).toBe(2);
    expect(counts.find((c) => c.agent_id === "codex")!.count).toBe(1);
  });

  it("listMemoryIdsByAgentId returns exactly the ids for one agent", () => {
    const { store, seed } = setup();
    seed({ id: "a", agent_id: "claude" });
    seed({ id: "b", agent_id: "claude" });
    seed({ id: "c", agent_id: "codex" });
    expect(store.listMemoryIdsByAgentId("claude").sort()).toEqual(["a", "b"]);
    expect(store.listMemoryIdsByAgentId("codex")).toEqual(["c"]);
    expect(store.listMemoryIdsByAgentId("nobody")).toEqual([]);
  });
});

describe("markdown MemoryStore — bulkUpdateMemory", () => {
  it("re-homes agent_id across a set and reports the count", () => {
    const { store, seed } = setup();
    seed({ id: "a", agent_id: "codex" });
    seed({ id: "b", agent_id: "codex" });
    const result = store.bulkUpdateMemory({
      ids: ["a", "b", "ghost"],
      patch: { agent_id: "claude" },
    });
    expect(result.transaction_id).toMatch(/^txn_/);
    expect(result.updated).toBe(2); // ghost skipped
    expect(store.getMemory("a")!.agent_id).toBe("claude");
    expect(store.getMemory("b")!.agent_id).toBe("claude");
  });

  it("throws on an empty patch", () => {
    const { store } = setup();
    expect(() => store.bulkUpdateMemory({ ids: ["a"], patch: {} })).toThrow(/agent_id/);
  });
});

describe("markdown MemoryStore — distinctValues", () => {
  it("returns deduped, case-insensitively-sorted values, excluding archived", () => {
    const { store, seed } = setup();
    seed({ id: "a", agent_id: "Bob" });
    seed({ id: "b", agent_id: "alice" });
    seed({ id: "c", agent_id: "alice" });
    seed({ id: "d", agent_id: "zed", status: "archived" });
    expect(store.distinctValues({ field: "agent_id" })).toEqual(["alice", "Bob"]);
    expect(store.distinctValues({ field: "agent_id", include_archived: true })).toEqual([
      "alice",
      "Bob",
      "zed",
    ]);
  });

  it("rejects a field outside the whitelist", () => {
    const { store } = setup();
    expect(() => store.distinctValues({ field: "title" })).toThrow(/not allowed/);
  });
});

describe("markdown MemoryStore — recordRecall", () => {
  it("is a no-op (recall tracking is retired in the markdown model)", () => {
    const { store, seed } = setup();
    const memory = seed({ id: "a" });
    expect(() => store.recordRecall([memory], "codex", "q")).not.toThrow();
    expect(store.recordRecall([], "codex", "q")).toBeUndefined();
  });
});
