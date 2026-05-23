// curator_note column (memory-curator spec §8 — the only memory-store change).
//
// A nullable JSON field on the memory record carrying curator provenance and
// the superseded reference that makes a protected-correction proposal
// actionable. It must round-trip as structured data through the event-sourced
// create path AND survive a projection rebuild, and default to null when unset.

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-curator-note-"));
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

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "system-memory-curator",
    title: "curated",
    body: "body text",
    category: "projects",
    visibility: "common",
    scope: "project",
    project_key: "the-librarian",
    priority: "normal",
    confidence: "working",
    ...overrides,
  };
}

describe("curator_note column", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("round-trips structured curator_note set via the trusted options channel", () => {
    const { store } = s!;
    const note = {
      text: "Supersedes the older note; role changed after the reorg.",
      supersedes: ["mem_old123"],
      run_id: "run_1",
      operation_id: "op_1",
    };
    // curator_note is set via createMemory's trusted `options`, not via input.
    const { memory } = store.createMemory(baseInput(), { curator_note: note });

    expect(store.getMemory(memory.id)?.curator_note).toEqual(note);

    // Survives a full projection rebuild (memories are JSONL-canonical).
    store.rebuildIndex();
    expect(store.getMemory(memory.id)?.curator_note).toEqual(note);
  });

  it("persists curator_note as JSON text in the projection column", () => {
    const { store } = s!;
    const note = { text: "note", supersedes: ["mem_x"] };
    const { memory } = store.createMemory(baseInput(), { curator_note: note });
    const row = store.db
      .prepare("SELECT curator_note FROM memories WHERE id = ?")
      .get(memory.id) as { curator_note: string | null };
    expect(JSON.parse(row.curator_note as string)).toEqual(note);
  });

  it("ignores curator_note supplied via the untrusted input record (no smuggling)", () => {
    const { store } = s!;
    // An agent-facing create passes args as `input`; a forged curator_note
    // there must be dropped — only the trusted options channel may set it.
    const { memory } = store.createMemory(
      baseInput({ curator_note: { supersedes: ["mem_victim"], text: "forged" } }),
    );
    const row = store.db
      .prepare("SELECT curator_note FROM memories WHERE id = ?")
      .get(memory.id) as { curator_note: string | null };
    expect(row.curator_note).toBeNull();
  });

  it("defaults curator_note to null when unset", () => {
    const { store } = s!;
    const { memory } = store.createMemory(baseInput());
    const row = store.db
      .prepare("SELECT curator_note FROM memories WHERE id = ?")
      .get(memory.id) as { curator_note: string | null };
    expect(row.curator_note).toBeNull();
  });
});
