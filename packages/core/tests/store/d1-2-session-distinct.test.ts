// D1.2 — distinctSessionValues coverage.
//
// Mirrors the D1.1 memory tests: column whitelist, default ended
// exclusion, include_ended opt-in, and the SQL-injection guard.

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-d1-2-"));
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

function seedSession(
  store: LibrarianStore,
  overrides: Partial<{ title: string; harness: string; project_key: string }> = {},
): string {
  const result = store.startSession({
    agent_id: "bede",
    title: overrides.title || "seed",
    harness: overrides.harness || "claude-code",
    project_key: overrides.project_key || "the-librarian",
    start_summary: "test",
  });
  return result.session!.id;
}

describe("D1.2 distinctSessionValues", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("returns the deduplicated current_harness set", () => {
    const { store } = s!;
    seedSession(store, { harness: "claude-code" });
    seedSession(store, { harness: "claude-code" });
    seedSession(store, { harness: "codex" });
    const values = store.distinctSessionValues({ field: "current_harness" });
    expect([...values].sort()).toEqual(["claude-code", "codex"]);
  });

  it("excludes ended sessions by default", () => {
    const { store } = s!;
    seedSession(store, { project_key: "kept" });
    const stale = seedSession(store, { project_key: "stale" });
    store.endSession({ agent_id: "bede", session_id: stale });
    const values = store.distinctSessionValues({ field: "project_key" });
    expect(values).toContain("kept");
    expect(values).not.toContain("stale");
  });

  it("with include_ended: true surfaces ended sessions", () => {
    const { store } = s!;
    seedSession(store, { project_key: "live" });
    const stale = seedSession(store, { project_key: "stale" });
    store.endSession({ agent_id: "bede", session_id: stale });
    const values = store.distinctSessionValues({ field: "project_key", include_ended: true });
    expect(values).toContain("live");
    expect(values).toContain("stale");
  });

  it("rejects fields outside the whitelist", () => {
    const { store } = s!;
    seedSession(store);
    expect(() =>
      store.distinctSessionValues({
        field: "rolling_summary; DROP TABLE sessions;--" as unknown as string,
      }),
    ).toThrow(/not allowed/i);
  });

  it("allows the cwd column (S1.x: cwd is part of the filter set)", () => {
    const { store } = s!;
    store.startSession({
      agent_id: "bede",
      title: "with cwd",
      harness: "claude-code",
      cwd: "/home/jim/projectA",
      start_summary: "test",
    });
    const values = store.distinctSessionValues({ field: "cwd" });
    expect(values).toContain("/home/jim/projectA");
  });
});
