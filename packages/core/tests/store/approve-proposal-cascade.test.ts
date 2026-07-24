// Approve-cascade — spec 072 T1 (SC 1, 2, 3).
//
// Spec 058 (D4) made a SINGLE approval correct: approving an
// update/supersede/merge archives the sources it replaces. It left
// CONCURRENCY between proposals unhandled — two open proposals may supersede
// the same memory M, and approving both used to leave TWO active memories both
// claiming to replace M (the second archive of M no-ops, because archiveMemory
// is idempotent, so nothing objected).
//
// The cascade is keyed on what was ARCHIVED, not on what was approved: only the
// update/supersede/merge arm archives sources, so only it can invalidate peers.
// create and split archive nothing, so nothing cascades — which is what keeps a
// split's sibling replacements (they all supersede the same source, by
// construction) alive when one of them is approved.
//
// Withdrawal reuses the resolveProposal seam: the peer is archived WITH
// provenance (curator_note.resolution) and stays in git, not deleted.

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-approve-cascade-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = "2026-07-24T00:00:00.000Z";

function setup() {
  const vault = createVault({ dataDir });
  const store = createMarkdownMemoryStore({ vault, now: () => NOW });
  const seed = (over: Partial<Memory> & { id: string }): Memory => {
    const memory: Memory = {
      id: over.id,
      title: over.title ?? over.id,
      body: over.body ?? "body",
      agent_id: over.agent_id ?? "codex",
      confidence: "working",
      tags: [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      flags: [],
      status: over.status ?? "active",
      is_global: false,
      requires_approval: over.requires_approval ?? false,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      curator_note: over.curator_note ?? null,
    };
    vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
    return memory;
  };
  return { vault, store, seed };
}

describe("approveProposal — cascade over invalidated peers (spec 072 SC 1/2)", () => {
  it("withdraws an open peer proposal that superseded the same source", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active", title: "fact", body: "old value" });
    seed({
      id: "a",
      status: "proposed",
      body: "new value A",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    seed({
      id: "b",
      status: "proposed",
      body: "new value B",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });

    store.approveProposal("a", "approve");

    expect(store.getMemory("a")!.status).toBe("active");
    expect(store.getMemory("t")!.status).toBe("archived");
    const peer = store.getMemory("b")!;
    expect(peer.status).toBe("archived");
    expect(peer.curator_note!.resolution).toBe("superseded_by_approval:a");
  });

  it("leaves exactly one open proposal and one active descendant of the source", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "a",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    seed({
      id: "b",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });

    store.approveProposal("a", "approve");

    expect(store.listMemories({ status: "proposed" }).total).toBe(0);
    expect(store.listMemories({ status: "active" }).total).toBe(1);
  });

  it("makes the double-approve divergence unreachable", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "a",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    seed({
      id: "b",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });

    store.approveProposal("a", "approve");
    expect(() => store.approveProposal("b", "approve")).toThrow(/not proposed/);
  });

  it("withdraws peers pointing at ANY source of an approved merge", () => {
    const { store, seed } = setup();
    seed({ id: "x", status: "active" });
    seed({ id: "y", status: "active" });
    seed({ id: "z", status: "active" });
    seed({
      id: "m",
      status: "proposed",
      curator_note: { proposed_action: "merge", supersedes: ["x", "y"] },
    });
    // Overlaps on y only — still invalidated, y is gone.
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["y"] },
    });
    // Touches z, which the merge never archived — must survive.
    seed({
      id: "q",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["z"] },
    });

    store.approveProposal("m", "approve");

    expect(store.getMemory("p")!.status).toBe("archived");
    expect(store.getMemory("p")!.curator_note!.resolution).toBe("superseded_by_approval:m");
    expect(store.getMemory("q")!.status).toBe("proposed");
  });

  it("does not withdraw a peer whose source was never archived", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({ id: "u", status: "active" });
    seed({
      id: "a",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    seed({
      id: "b",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["u"] },
    });

    store.approveProposal("a", "approve");

    expect(store.getMemory("b")!.status).toBe("proposed");
  });

  it("does not cascade when rejecting — the source stays live, so peers stay valid", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "a",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    seed({
      id: "b",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });

    store.approveProposal("a", "reject");

    expect(store.getMemory("t")!.status).toBe("active");
    expect(store.getMemory("b")!.status).toBe("proposed");
  });

  it("does not cascade for a create, which archives nothing", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "a",
      status: "proposed",
      curator_note: { proposed_action: "create", source: "intake" },
    });
    seed({
      id: "b",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });

    store.approveProposal("a", "approve");

    expect(store.getMemory("b")!.status).toBe("proposed");
  });
});

describe("approveProposal — split siblings survive (spec 072 SC 3)", () => {
  it("leaves the other replacements of the same split open", () => {
    const { store, seed } = setup();
    seed({ id: "s", status: "active" });
    for (const id of ["r1", "r2", "r3"]) {
      seed({
        id,
        status: "proposed",
        curator_note: { proposed_action: "split", supersedes: ["s"], run_id: "run-1" },
      });
    }

    store.approveProposal("r1", "approve");

    expect(store.getMemory("r1")!.status).toBe("active");
    expect(store.getMemory("s")!.status).toBe("active");
    expect(store.getMemory("r2")!.status).toBe("proposed");
    expect(store.getMemory("r3")!.status).toBe("proposed");
  });

  it("withdraws pending splits of a source that an approved update archived", () => {
    const { store, seed } = setup();
    seed({ id: "s", status: "active" });
    seed({
      id: "u",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["s"] },
    });
    seed({
      id: "r1",
      status: "proposed",
      curator_note: { proposed_action: "split", supersedes: ["s"] },
    });
    seed({
      id: "r2",
      status: "proposed",
      curator_note: { proposed_action: "split", supersedes: ["s"] },
    });

    store.approveProposal("u", "approve");

    // s is archived, so its pending split replacements are decisions about a
    // memory that no longer exists in the active corpus.
    expect(store.getMemory("r1")!.status).toBe("archived");
    expect(store.getMemory("r2")!.status).toBe("archived");
  });
});
