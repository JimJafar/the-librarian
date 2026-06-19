// Markdown MemoryStore — updateMemory / archiveMemory / flagMemory /
// resolveFlags / approveProposal (plan 036 Phase 2; flag verbs from spec 047 /
// ADR 0006). The store applies the transitions directly to the document.
// Pins: the protection gate
// + status-patch guard on update, the idempotent archive, the route-to-review
// flag accumulation + resolution, and the proposal approve/reject transitions.

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-mut-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = "2026-07-01T00:00:00.000Z";

function setup() {
  const vault = createVault({ dataDir });
  const store = createMarkdownMemoryStore({ vault, now: () => NOW });
  const seed = (over: Partial<Memory> & { id: string }): Memory => {
    const memory: Memory = {
      id: over.id,
      title: over.title ?? over.id,
      body: over.body ?? "body",
      agent_id: over.agent_id ?? "codex",
      project_key: over.project_key ?? null,
      confidence: "working",
      tags: over.tags ?? [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      recall_count: 0,
      usefulness_score: over.usefulness_score ?? 0,
      status: over.status ?? "active",
      is_global: false,
      requires_approval: over.requires_approval ?? false,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      curator_note: null,
    };
    vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
    return memory;
  };
  return { vault, store, seed };
}

describe("markdown MemoryStore — updateMemory", () => {
  it("applies a whitelisted patch and bumps updated_at", () => {
    const { store, seed } = setup();
    seed({ id: "m", title: "old", body: "old body" });
    const updated = store.updateMemory("m", { title: "new", body: "new body" });
    expect(updated!.title).toBe("new");
    expect(updated!.body).toBe("new body");
    expect(updated!.updated_at).toBe(NOW);
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.updateMemory("ghost", { title: "x" })).toThrow(/No memory found/);
  });

  it("rejects a status change via updateMemory", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(() => store.updateMemory("m", { status: "archived" })).toThrow(/status changes/);
  });

  it("blocks edits to a protected active memory unless allowProtected is set", () => {
    const { store, seed } = setup();
    seed({ id: "p", status: "active", requires_approval: true });
    expect(() => store.updateMemory("p", { body: "edit" })).toThrow(/Protected memories/);
    const ok = store.updateMemory("p", { body: "edit" }, "codex", { allowProtected: true });
    expect(ok!.body).toBe("edit");
  });

  it("strips protected fields smuggled through a patch (cleanPatch allow-list)", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active", requires_approval: false });
    const updated = store.updateMemory("m", {
      body: "ok",
      is_global: true,
      requires_approval: true,
      curator_note: { forged: true },
    });
    expect(updated!.body).toBe("ok");
    expect(updated!.is_global).toBe(false);
    expect(updated!.requires_approval).toBe(false);
    expect(updated!.curator_note).toBeNull();
  });
});

describe("markdown MemoryStore — archiveMemory", () => {
  it("archives a memory and is idempotent", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(store.archiveMemory("m")!.status).toBe("archived");
    expect(store.archiveMemory("m")!.status).toBe("archived"); // no-op second call
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.archiveMemory("ghost")).toThrow(/No memory found/);
  });
});

describe("markdown MemoryStore — unarchiveMemory", () => {
  it("restores an archived memory to active and bumps updated_at", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "archived" });
    const restored = store.unarchiveMemory("m");
    expect(restored!.status).toBe("active");
    expect(restored!.updated_at).toBe(NOW);
  });

  it("is idempotent on an already-active memory (no-op)", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(store.unarchiveMemory("m")!.status).toBe("active"); // already active → no-op
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.unarchiveMemory("ghost")).toThrow(/No memory found/);
  });
});

describe("markdown MemoryStore — purgeMemory", () => {
  it("hard-deletes an archived memory (file gone, getMemory null) and is idempotent", () => {
    const { store, vault, seed } = setup();
    seed({ id: "m", status: "archived" });
    expect(vault.exists("memories/m.md")).toBe(true);

    const purged = store.purgeMemory("m");
    expect(purged!.id).toBe("m");
    expect(vault.exists("memories/m.md")).toBe(false);
    expect(store.getMemory("m")).toBeNull();

    // idempotent — purging an already-absent memory is a no-op returning null
    expect(store.purgeMemory("m")).toBeNull();
  });

  it("refuses to purge a non-archived memory (archive first) and leaves it untouched", () => {
    const { store, seed } = setup();
    seed({ id: "a", status: "active" });
    expect(() => store.purgeMemory("a")).toThrow(/archived/i);
    expect(store.getMemory("a")!.status).toBe("active");
  });

  it("is a no-op for an unknown id", () => {
    const { store } = setup();
    expect(store.purgeMemory("ghost")).toBeNull();
  });
});

describe("markdown MemoryStore — flagMemory", () => {
  it("records a flag without changing the memory's status", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    const flagged = store.flagMemory("m", "this is outdated", "codex");
    expect(flagged!.status).toBe("active"); // route-to-review, never archive
    expect(flagged!.flags).toEqual([
      { agent_id: "codex", reason: "this is outdated", created_at: NOW },
    ]);
    expect(flagged!.updated_at).toBe(NOW);
  });

  it("accumulates flags from multiple agents", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    store.flagMemory("m", "wrong", "codex");
    const flagged = store.flagMemory("m", "misleading", "claude");
    expect(flagged!.flags).toEqual([
      { agent_id: "codex", reason: "wrong", created_at: NOW },
      { agent_id: "claude", reason: "misleading", created_at: NOW },
    ]);
  });

  it("is a fail-soft no-op returning null for an unknown id", () => {
    const { store } = setup();
    expect(store.flagMemory("ghost", "reason", "codex")).toBeNull();
  });
});

describe("markdown MemoryStore — resolveFlags", () => {
  it("clears the flags list and leaves status unchanged", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    store.flagMemory("m", "wrong", "codex");
    store.flagMemory("m", "stale", "claude");
    const resolved = store.resolveFlags("m", "dashboard");
    expect(resolved!.flags).toEqual([]);
    expect(resolved!.status).toBe("active");
  });

  it("is a fail-soft no-op returning null for an unknown id", () => {
    const { store } = setup();
    expect(store.resolveFlags("ghost", "dashboard")).toBeNull();
  });
});

describe("markdown MemoryStore — listMemories has_open_flags filter", () => {
  it("returns only memories with at least one open flag when has_open_flags is true", () => {
    const { store, seed } = setup();
    seed({ id: "flagged", status: "active" });
    seed({ id: "clean", status: "active" });
    store.flagMemory("flagged", "wrong", "codex");

    const ids = store.listMemories({ has_open_flags: true }).memories.map((m) => m.id);
    expect(ids).toEqual(["flagged"]);
  });

  it("returns only memories with no open flags when has_open_flags is false", () => {
    const { store, seed } = setup();
    seed({ id: "flagged", status: "active" });
    seed({ id: "clean", status: "active" });
    store.flagMemory("flagged", "wrong", "codex");

    const ids = store.listMemories({ has_open_flags: false }).memories.map((m) => m.id);
    expect(ids).toEqual(["clean"]);
  });

  it("excludes a memory once its flags are resolved", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    store.flagMemory("m", "wrong", "codex");
    expect(store.listMemories({ has_open_flags: true }).memories.map((m) => m.id)).toEqual(["m"]);
    store.resolveFlags("m", "dashboard");
    expect(store.listMemories({ has_open_flags: true }).memories).toEqual([]);
  });
});

describe("markdown MemoryStore — approveProposal", () => {
  it("approves a proposed memory to active, applying a patch", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "proposed", body: "draft" });
    const approved = store.approveProposal("m", "approve", { body: "reviewed" });
    expect(approved!.status).toBe("active");
    expect(approved!.body).toBe("reviewed");
  });

  it("rejects a proposed memory to archived", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "proposed" });
    expect(store.approveProposal("m", "reject")!.status).toBe("archived");
  });

  it("strips protected fields smuggled through an approve patch", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "proposed", requires_approval: true });
    const approved = store.approveProposal("m", "approve", {
      body: "reviewed",
      is_global: true,
      requires_approval: false,
    });
    expect(approved!.status).toBe("active");
    expect(approved!.body).toBe("reviewed");
    expect(approved!.is_global).toBe(false); // smuggled value dropped
    expect(approved!.requires_approval).toBe(true); // unchanged by the patch
  });

  it("throws when the memory is not proposed", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(() => store.approveProposal("m")).toThrow(/not proposed/);
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.approveProposal("ghost")).toThrow(/No memory found/);
  });
});
