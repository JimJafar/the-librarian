// Markdown MemoryStore — updateMemory / archiveMemory / verifyMemory /
// approveProposal (plan 036 Phase 2). The SQLite store reaches these via
// events + the projection; the markdown store applies the transitions
// directly. Parity: the protection gate + status-patch guard on update, the
// idempotent archive, the verify usefulness delta (±1, clamp ±3, outdated →
// archived), and the proposal approve/reject transitions.

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
      priority: over.priority ?? "normal",
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

describe("markdown MemoryStore — verifyMemory", () => {
  it("nudges usefulness +1 / -1 and clamps to ±3", () => {
    const { store, seed } = setup();
    seed({ id: "m", usefulness_score: 0 });
    expect(store.verifyMemory("m", "useful")!.usefulness_score).toBe(1);
    expect(store.verifyMemory("m", "not_useful")!.usefulness_score).toBe(0);
    for (let i = 0; i < 5; i++) store.verifyMemory("m", "useful");
    expect(store.getMemory("m")!.usefulness_score).toBe(3); // clamped
  });

  it("outdated archives the memory and leaves the score unchanged", () => {
    const { store, seed } = setup();
    seed({ id: "m", usefulness_score: 2, status: "active" });
    const result = store.verifyMemory("m", "outdated");
    expect(result!.status).toBe("archived");
    expect(result!.usefulness_score).toBe(2);
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
