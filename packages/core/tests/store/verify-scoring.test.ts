// V1.1 — Live verify_memory + recall scoring.
//
// Pins the load-bearing semantics introduced by the memory-simplification
// spec:
//   - verify(useful)     → usefulness_score += 1, clamped to ≤ +3
//   - verify(not_useful) → usefulness_score -= 1, clamped to ≥ -3
//   - verify(outdated)   → status → archived, score unchanged
//   - recall scoring     → includes clamp(usefulness_score, -3, +3)
//   - projection rebuild → preserves all of the above from the JSONL ledger

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function makeScope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-verify-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function teardown(scope: Scope | null): void {
  if (!scope) return;
  try {
    scope.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(scope.dataDir, { recursive: true, force: true });
}

function makeMemory(store: LibrarianStore, overrides: Record<string, unknown> = {}) {
  return store.createMemory({
    agent_id: "codex",
    title: "Test tool flag",
    body: "Use --watch for the local test runner to keep results fresh.",
    category: "tools",
    visibility: "common",
    scope: "project",
    project_key: "the-librarian",
    ...overrides,
  });
}

describe("V1.1 — verify_memory + scoring", () => {
  let scope: Scope | null = null;

  beforeEach(() => {
    scope = makeScope();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("useful increments usefulness_score by 1", () => {
    const { store } = scope!;
    const { memory } = makeMemory(store);
    expect(memory.usefulness_score).toBe(0);
    const verified = store.verifyMemory(memory.id, "useful", "", "codex");
    expect(verified!.usefulness_score).toBe(1);
  });

  it("not_useful decrements usefulness_score by 1", () => {
    const { store } = scope!;
    const { memory } = makeMemory(store);
    const verified = store.verifyMemory(memory.id, "not_useful", "", "codex");
    expect(verified!.usefulness_score).toBe(-1);
  });

  it("useful clamps at +3 (5x useful still yields +3)", () => {
    const { store } = scope!;
    const { memory } = makeMemory(store);
    let final = memory;
    for (let i = 0; i < 5; i++) {
      final = store.verifyMemory(memory.id, "useful", "", "codex")!;
    }
    expect(final.usefulness_score).toBe(3);
  });

  it("not_useful clamps at -3", () => {
    const { store } = scope!;
    const { memory } = makeMemory(store);
    let final = memory;
    for (let i = 0; i < 5; i++) {
      final = store.verifyMemory(memory.id, "not_useful", "", "codex")!;
    }
    expect(final.usefulness_score).toBe(-3);
  });

  it("outdated archives the memory and leaves usefulness_score unchanged", () => {
    const { store } = scope!;
    const { memory } = makeMemory(store);
    store.verifyMemory(memory.id, "useful", "", "codex"); // score → 1
    const verified = store.verifyMemory(memory.id, "outdated", "stale", "codex");
    expect(verified!.status).toBe("archived");
    expect(verified!.usefulness_score).toBe(1);
  });

  it("archived memories drop out of default recall", () => {
    const { store } = scope!;
    const { memory } = makeMemory(store, {
      title: "Outdated CLI flag",
      body: "The deploy CLI used to take --legacy; that flag has been removed.",
    });
    expect(
      store.searchMemories({ query: "deploy CLI legacy flag", project_key: "the-librarian" })
        .length,
    ).toBe(1);
    store.verifyMemory(memory.id, "outdated", "", "codex");
    expect(
      store.searchMemories({ query: "deploy CLI legacy flag", project_key: "the-librarian" })
        .length,
    ).toBe(0);
  });

  it("outdated emits both memory.verified and memory.archived events", () => {
    const { store } = scope!;
    const { memory } = makeMemory(store);
    store.verifyMemory(memory.id, "outdated", "", "codex");
    const events = store.readEvents() as { event_type: string; memory_id: string }[];
    const forMemory = events.filter((e) => e.memory_id === memory.id);
    expect(forMemory.some((e) => e.event_type === "memory.verified")).toBe(true);
    expect(forMemory.some((e) => e.event_type === "memory.archived")).toBe(true);
  });

  it("recall ranks higher usefulness_score above an otherwise-identical memory", () => {
    const { store } = scope!;
    const popular = store.createMemory({
      agent_id: "codex",
      title: "Popular tooling note",
      body: "Run pnpm test before pushing to catch broken specs.",
      category: "tools",
      visibility: "common",
      scope: "project",
      project_key: "popular-proj",
    });
    const ignored = store.createMemory({
      agent_id: "codex",
      title: "Ignored tooling note",
      body: "Run pnpm test before pushing to catch broken specs.",
      category: "tools",
      visibility: "common",
      scope: "project",
      project_key: "ignored-proj",
    });
    for (let i = 0; i < 3; i++) {
      store.verifyMemory(popular.memory.id, "useful", "", "codex");
    }

    const results = store.searchMemories({
      query: "pnpm test broken specs",
      project_key: "",
      limit: 8,
    });
    const popularIdx = results.findIndex((m) => m.id === popular.memory.id);
    const ignoredIdx = results.findIndex((m) => m.id === ignored.memory.id);
    expect(popularIdx).toBeGreaterThanOrEqual(0);
    expect(ignoredIdx).toBeGreaterThanOrEqual(0);
    expect(popularIdx).toBeLessThan(ignoredIdx);
  });

  it("projection rebuild preserves usefulness_score and archive status", () => {
    const { store, dataDir } = scope!;
    const ranked = makeMemory(store, { title: "Survives rebuild" });
    const archived = makeMemory(store, {
      title: "Outdated after rebuild",
      body: "The legacy_flag CLI option no longer exists.",
    });
    for (let i = 0; i < 4; i++) {
      store.verifyMemory(ranked.memory.id, "useful", "", "codex");
    }
    store.verifyMemory(archived.memory.id, "outdated", "", "codex");
    store.close();

    fs.unlinkSync(path.join(dataDir, "librarian.sqlite"));
    const rebuilt = createLibrarianStore({ dataDir });
    try {
      const rankedRow = rebuilt.getMemory(ranked.memory.id)!;
      expect(rankedRow.usefulness_score).toBe(3);
      const archivedRow = rebuilt.getMemory(archived.memory.id)!;
      expect(archivedRow.status).toBe("archived");
    } finally {
      rebuilt.close();
      scope = null;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
