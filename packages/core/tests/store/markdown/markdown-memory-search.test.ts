// Markdown MemoryStore — searchMemories / detectRelated / getRelated (Phase 2).
//
// Keyword-scoring recall + token-overlap similarity
// (term length 3/1; flag penalty; archived excluded; duplicate ratio ≥ 0.55;
// related ≥ 0.32).

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-search-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const vault = createVault({ dataDir });
  let counter = 0;
  const store = createMarkdownMemoryStore({ vault, generateId: () => `mem_t${++counter}` });
  const seed = (over: Partial<Memory> & { id: string }): Memory => {
    const memory: Memory = {
      id: over.id,
      title: over.title ?? over.id,
      body: over.body ?? "body",
      agent_id: over.agent_id ?? "codex",
      confidence: "working",
      tags: over.tags ?? [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      status: over.status ?? "active",
      is_global: false,
      requires_approval: false,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: over.updated_at ?? "2026-06-01T00:00:00.000Z",
      curator_note: null,
    };
    vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
    return memory;
  };
  return { vault, store, seed };
}

describe("markdown MemoryStore — searchMemories", () => {
  it("scores keyword matches and drops non-matches", () => {
    const { store, seed } = setup();
    seed({ id: "pnpm", title: "pnpm workspace setup", body: "use pnpm for the monorepo" });
    seed({ id: "cal", title: "calendar", body: "tuesdays only" });
    const hits = store.searchMemories({ query: "pnpm monorepo" });
    expect(hits.map((m) => m.id)).toEqual(["pnpm"]);
  });

  it("returns up to limit (recent-first) when the query is empty", () => {
    const { store, seed } = setup();
    seed({ id: "a", updated_at: "2026-06-01T00:00:00.000Z" });
    seed({ id: "b", updated_at: "2026-06-09T00:00:00.000Z" });
    expect(store.searchMemories({ limit: 1 })).toHaveLength(1);
    expect(store.searchMemories({}).map((m) => m.id)).toContain("a");
  });

  it("excludes archived memories", () => {
    const { store, seed } = setup();
    seed({ id: "live", title: "deploy command", body: "run deploy" });
    seed({ id: "dead", title: "deploy command", body: "run deploy", status: "archived" });
    expect(store.searchMemories({ query: "deploy" }).map((m) => m.id)).toEqual(["live"]);
  });

  it("filters by tag (OR) before scoring", () => {
    const { store, seed } = setup();
    seed({ id: "x", title: "deploy alpha", body: "deploy", tags: ["ops"] });
    seed({ id: "y", title: "deploy beta", body: "deploy", tags: ["docs"] });
    expect(store.searchMemories({ query: "deploy", tags: ["ops"] }).map((m) => m.id)).toEqual([
      "x",
    ]);
  });

  it("soft-demotes a flagged memory below an equal unflagged one but still returns it", () => {
    const { store, seed } = setup();
    seed({ id: "clean", title: "deploy notes", body: "deploy" });
    seed({ id: "flagged", title: "deploy notes", body: "deploy" });
    store.flagMemory("flagged", "this is wrong", "codex");
    // Both still surface (route-to-review, not exclusion); the flagged one ranks last.
    expect(store.searchMemories({ query: "deploy" }).map((m) => m.id)).toEqual([
      "clean",
      "flagged",
    ]);
  });
});

describe("markdown MemoryStore — detectRelated + getRelated", () => {
  it("flags a high-overlap memory as a duplicate and ignores a low-overlap one", () => {
    const { store, seed } = setup();
    seed({ id: "dup", title: "alpha beta gamma delta", body: "alpha beta gamma delta" });
    seed({ id: "far", title: "unrelated subject matter", body: "nothing alike here" });
    const candidate: Memory = {
      ...seed({ id: "cand", title: "alpha beta gamma delta", body: "alpha beta gamma delta" }),
    };
    const { duplicates } = store.detectRelated(candidate);
    expect(duplicates.map((m) => m.id)).toEqual(["dup"]);
  });

  it("getRelated ranks by ratio, flags isDuplicate (≥0.55), and filters below 0.32", () => {
    const { store, seed } = setup();
    const base = seed({
      id: "base",
      title: "alpha beta gamma delta",
      body: "alpha beta gamma delta",
    });
    // near shares 3/4 terms → 0.75 (duplicate); mid shares 2/4 → 0.5 (related,
    // not a duplicate); far shares 0 → excluded (< 0.32).
    seed({ id: "near", title: "alpha beta gamma epsilon", body: "alpha beta gamma epsilon" });
    seed({ id: "mid", title: "alpha beta epsilon zeta", body: "alpha beta epsilon zeta" });
    seed({ id: "far", title: "totally different words", body: "nothing in common at all" });
    const result = store.getRelated(base.id);
    expect(result).not.toBeNull();
    expect(result!.related.map((r) => ({ id: r.memory.id, dup: r.isDuplicate }))).toEqual([
      { id: "near", dup: true },
      { id: "mid", dup: false },
    ]);
  });

  it("getRelated returns null for an unknown id", () => {
    const { store } = setup();
    expect(store.getRelated("mem_ghost")).toBeNull();
  });

  it("createMemory surfaces duplicates of an existing similar memory", () => {
    const { store } = setup();
    store.createMemory({
      agent_id: "codex",
      title: "alpha beta gamma delta",
      body: "alpha beta gamma delta",
    });
    const result = store.createMemory({
      agent_id: "codex",
      title: "alpha beta gamma delta",
      body: "alpha beta gamma delta",
    });
    expect(result.duplicates).toHaveLength(1);
  });
});
