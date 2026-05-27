// T4.1 — domains CRUD behaviour tests.
//
// The owner curates the domain list via the dashboard's `/domains`
// page, which calls into `store.domains.{list, add, remove}`. Pins:
//   - The `general` floor is always present and can't be removed.
//   - Removing a domain reassigns its memories to `general` rather
//     than deleting them (no data loss on owner cleanup).
//   - `memory_count` is accurate on list.

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-domains-"));
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

describe("domains store (T4.1)", () => {
  let scope: Scope | null = null;

  beforeEach(() => {
    scope = makeScope();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("list returns the seeded `general` domain on a fresh install", () => {
    const rows = scope!.store.domains.list();
    expect(rows.map((r) => r.name)).toEqual(["general"]);
    expect(rows[0].memory_count).toBe(0);
  });

  it("add inserts a new domain and the returned row carries memory_count: 0", () => {
    const created = scope!.store.domains.add("coding");
    expect(created.name).toBe("coding");
    expect(created.memory_count).toBe(0);
    const names = scope!.store.domains.list().map((r) => r.name);
    expect(names).toEqual(["coding", "general"]);
  });

  it("add trims whitespace and rejects empty / oversized names", () => {
    const trimmed = scope!.store.domains.add("  family  ");
    expect(trimmed.name).toBe("family");
    expect(() => scope!.store.domains.add("")).toThrow(/non-empty/);
    expect(() => scope!.store.domains.add("   ")).toThrow(/non-empty/);
    expect(() => scope!.store.domains.add("x".repeat(65))).toThrow(/64 characters/);
  });

  it("list reports an accurate memory_count per domain", () => {
    scope!.store.domains.add("coding");
    scope!.store.createMemory(
      {
        agent_id: "codex",
        title: "pnpm note",
        body: "use pnpm",
        category: "tools",
        visibility: "common",
        scope: "tool",
      },
      { domain: "coding" },
    );
    scope!.store.createMemory(
      {
        agent_id: "codex",
        title: "general note",
        body: "general body",
        category: "tools",
        visibility: "common",
        scope: "tool",
      },
      { domain: "general" },
    );
    const rows = scope!.store.domains.list();
    expect(rows.find((r) => r.name === "coding")?.memory_count).toBe(1);
    expect(rows.find((r) => r.name === "general")?.memory_count).toBe(1);
  });

  it("remove reassigns the domain's memories to `general`", () => {
    scope!.store.domains.add("coding");
    const codingMemory = scope!.store.createMemory(
      {
        agent_id: "codex",
        title: "coding memory",
        body: "stays alive",
        category: "tools",
        visibility: "common",
        scope: "tool",
      },
      { domain: "coding" },
    );
    const result = scope!.store.domains.remove("coding");
    expect(result.reassigned).toBe(1);
    const survivor = scope!.store.getMemory(codingMemory.memory.id);
    expect(survivor).toBeTruthy();
    expect(survivor?.domain).toBe("general");
    expect(scope!.store.domains.list().map((r) => r.name)).toEqual(["general"]);
  });

  it("remove rejects the floor domain `general`", () => {
    expect(() => scope!.store.domains.remove("general")).toThrow(/floor domain/);
  });

  it("remove rejects an unknown domain", () => {
    expect(() => scope!.store.domains.remove("never-was")).toThrow(/does not exist/);
  });
});
