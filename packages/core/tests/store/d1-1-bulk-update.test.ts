// D1.1 — bulk-update + distinctValues coverage.
//
// These tests pin the dashboard re-home flow's invariants at the
// store layer: (1) the patch is whitelisted to agent_id + project_key,
// (2) every emitted event carries the same transaction_id, (3) the
// projection applies the patch idempotently, and (4) distinctValues
// honors the column whitelist + the archived-row exclusion default.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-d1-1-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

function seedMemory(
  store: LibrarianStore,
  overrides: Partial<{ title: string; agent_id: string; project_key: string }> = {},
): string {
  const result = store.createMemory({
    agent_id: overrides.agent_id || "claude-code",
    title: overrides.title || "seed",
    body: "body text",
    category: "projects",
    visibility: "common",
    scope: "project",
    project_key: overrides.project_key || "the-librarian",
    priority: "normal",
    confidence: "working",
  });
  return result.memory.id;
}

describe("D1.1 bulkUpdateMemory + distinctValues", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("bulkUpdateMemory re-homes a set of memories to a new project_key", () => {
    const { store } = s!;
    const ids = [
      seedMemory(store, { project_key: "old-proj", title: "a" }),
      seedMemory(store, { project_key: "old-proj", title: "b" }),
      seedMemory(store, { project_key: "old-proj", title: "c" }),
    ];
    const result = store.bulkUpdateMemory({
      ids,
      patch: { project_key: "new-proj" },
      agent_id: "dashboard",
    });
    expect(result.updated).toBe(3);
    expect(result.transaction_id).toMatch(/^txn_/);
    for (const id of ids) {
      const m = store.getMemory(id);
      expect(m?.project_key).toBe("new-proj");
    }
  });

  it("bulkUpdateMemory emits one memory.bulk_updated event per id sharing a transaction_id", () => {
    const { store } = s!;
    const ids = [seedMemory(store), seedMemory(store)];
    const { transaction_id } = store.bulkUpdateMemory({
      ids,
      patch: { project_key: "x" },
    });
    const { events } = store.listEvents({ type: "memory.bulk_updated", limit: 100 });
    const matching = events.filter(
      (e) => (e.payload as { transaction_id?: string })?.transaction_id === transaction_id,
    );
    expect(matching.length).toBe(2);
    const memoryIds = new Set(matching.map((e) => e.memory_id));
    for (const id of ids) expect(memoryIds.has(id)).toBe(true);
  });

  it("bulkUpdateMemory rejects an empty patch", () => {
    const { store } = s!;
    const id = seedMemory(store);
    expect(() => store.bulkUpdateMemory({ ids: [id], patch: {} })).toThrow(/at least one/i);
  });

  it("bulkUpdateMemory ignores fields outside the whitelist", () => {
    const { store } = s!;
    const id = seedMemory(store, { title: "before" });
    store.bulkUpdateMemory({
      ids: [id],
      // @ts-expect-error — intentionally passing a disallowed field to
      // verify the store filters it out rather than applying it.
      patch: { project_key: "p", title: "after" },
    });
    const m = store.getMemory(id);
    expect(m?.project_key).toBe("p");
    expect(m?.title).toBe("before");
  });

  it("bulkUpdateMemory skips unknown ids without throwing", () => {
    const { store } = s!;
    const ok = seedMemory(store);
    const result = store.bulkUpdateMemory({
      ids: [ok, "mem_does_not_exist"],
      patch: { project_key: "p" },
    });
    expect(result.updated).toBe(1);
  });

  it("distinctValues returns the deduplicated agent_id set", () => {
    const { store } = s!;
    seedMemory(store, { agent_id: "claude-code" });
    seedMemory(store, { agent_id: "claude-code" });
    seedMemory(store, { agent_id: "codex" });
    const values = store.distinctValues({ field: "agent_id" });
    expect([...values].sort()).toEqual(["claude-code", "codex"]);
  });

  it("distinctValues excludes archived memories by default", () => {
    const { store } = s!;
    seedMemory(store, { project_key: "kept" });
    const stale = seedMemory(store, { project_key: "stale" });
    store.archiveMemory(stale);
    const values = store.distinctValues({ field: "project_key" });
    expect(values).toContain("kept");
    expect(values).not.toContain("stale");
  });

  it("distinctValues with include_archived: true surfaces archived rows too", () => {
    const { store } = s!;
    seedMemory(store, { project_key: "live" });
    const stale = seedMemory(store, { project_key: "stale" });
    store.archiveMemory(stale);
    const values = store.distinctValues({ field: "project_key", include_archived: true });
    expect(values).toContain("live");
    expect(values).toContain("stale");
  });

  it("distinctValues rejects fields outside the whitelist (no SQL injection)", () => {
    const { store } = s!;
    seedMemory(store);
    expect(() =>
      store.distinctValues({ field: "body; DROP TABLE memories;--" as unknown as string }),
    ).toThrow(/not allowed/i);
  });
});
