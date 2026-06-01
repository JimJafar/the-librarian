// Markdown-backed MemoryStore — createMemory + getMemory (plan 036 Phase 2).
//
// The inbox/write path: createMemory writes a markdown file (memories/<id>.md)
// via the shared normalize + routeMemoryWrite logic and the memory-doc
// mapping, optionally committing; getMemory reads it back by id. Parity-first
// (full Memory shape), sync, with an injected sync committer. These pin the
// write→read round-trip and the status routing on the new backend.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarkdownMemoryStore, createVault } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-store-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function makeStore() {
  const vault = createVault({ dataDir });
  const commits: string[] = [];
  let counter = 0;
  const store = createMarkdownMemoryStore({
    vault,
    commit: (message) => commits.push(message),
    now: () => "2026-06-01T00:00:00.000Z",
    generateId: () => `mem_test${++counter}`,
  });
  return { store, vault, commits };
}

describe("markdown MemoryStore — createMemory + getMemory", () => {
  it("createMemory writes a markdown file and returns an active memory", () => {
    const { store, vault } = makeStore();
    const result = store.createMemory({
      agent_id: "codex",
      title: "Use pnpm",
      body: "Always use pnpm.",
      tags: ["tooling"],
      project_key: "the-librarian",
    });
    expect(result.status).toBe("active");
    expect(result.memory.id).toBe("mem_test1");
    expect(result.duplicates).toEqual([]);
    expect(vault.exists("memories/mem_test1.md")).toBe(true);
    expect(vault.readText("memories/mem_test1.md")).toContain("Always use pnpm.");
  });

  it("getMemory round-trips the stored memory exactly", () => {
    const { store } = makeStore();
    const { memory } = store.createMemory({
      agent_id: "codex",
      title: "Use pnpm",
      body: "Always use pnpm.",
      tags: ["tooling"],
    });
    expect(store.getMemory(memory.id)).toEqual(memory);
  });

  it("getMemory returns null for an unknown id", () => {
    const { store } = makeStore();
    expect(store.getMemory("mem_ghost")).toBeNull();
  });

  it("routes a requires_approval write to proposed", () => {
    const { store } = makeStore();
    const result = store.createMemory(
      { agent_id: "codex", title: "Owner identity", body: "Jim is the owner." },
      { requires_approval: true },
    );
    expect(result.status).toBe("proposed");
    expect(result.memory.status).toBe("proposed");
    expect(result.memory.requires_approval).toBe(true);
  });

  it("routes a pendingClassification write to proposed with conservative defaults", () => {
    const { store } = makeStore();
    const result = store.createMemory(
      { agent_id: "codex", title: "x", body: "y" },
      { pendingClassification: true },
    );
    expect(result.status).toBe("proposed");
    expect(result.memory.requires_approval).toBe(true);
    expect(result.memory.is_global).toBe(false);
  });

  it("normalizes missing input fields (defaults title/body/agent_id)", () => {
    const { store } = makeStore();
    const { memory } = store.createMemory({});
    expect(memory.title).toBe("Untitled memory");
    expect(memory.priority).toBe("normal");
    expect(memory.confidence).toBe("working");
    expect(memory.usefulness_score).toBe(0);
    expect(memory.recall_count).toBe(0);
  });

  it("commits per write with the memory id in the message", () => {
    const { store, commits } = makeStore();
    store.createMemory({ agent_id: "codex", title: "a", body: "b" });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain("mem_test1");
  });

  it("works without a commit callback (commit is optional)", () => {
    const vault = createVault({ dataDir });
    const store = createMarkdownMemoryStore({ vault });
    const { memory } = store.createMemory({ agent_id: "codex", title: "a", body: "b" });
    expect(store.getMemory(memory.id)).not.toBeNull();
  });
});
