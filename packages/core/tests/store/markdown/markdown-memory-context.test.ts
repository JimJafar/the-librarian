// Markdown MemoryStore — startContext (plan 036 Phase 2). Composes
// is_global "Identity" memories + the agent's private + a query-relevant
// slice into the shared context-package prose, parity with the SQLite store.

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-ctx-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const vault = createVault({ dataDir });
  const store = createMarkdownMemoryStore({ vault });
  const seed = (over: Partial<Memory> & { id: string }): Memory => {
    const memory: Memory = {
      id: over.id,
      title: over.title ?? over.id,
      body: over.body ?? "body",
      agent_id: over.agent_id ?? "codex",
      project_key: over.project_key ?? null,
      priority: "normal",
      confidence: "working",
      tags: [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      recall_count: 0,
      usefulness_score: 0,
      status: over.status ?? "active",
      is_global: over.is_global ?? false,
      requires_approval: false,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      curator_note: null,
    };
    vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
    return memory;
  };
  return { vault, store, seed };
}

describe("markdown MemoryStore — startContext", () => {
  it("surfaces the Identity section (all active memories — listAll's is_global filter is a no-op)", () => {
    // Parity quirk faithfully replicated from the SQLite store: startContext
    // calls listAll({ is_global: true }), but listAll only filters
    // status/agent_id/project_key — the is_global axis is ignored — so the
    // "Identity" section is really every active memory, not just globals.
    const { store, seed } = setup();
    seed({ id: "g", title: "Owner is Jim", body: "Jim owns this.", is_global: true });
    seed({ id: "n", title: "non-global", body: "ordinary", is_global: false });
    const result = store.startContext({ agent_id: "codex" });
    expect(result.memories.map((m) => m.id).sort()).toEqual(["g", "n"]);
    expect(result.text).toContain("Identity");
    expect(result.text).toContain("Owner is Jim: Jim owns this.");
  });

  it("includes a query-relevant slice for a task summary", () => {
    const { store, seed } = setup();
    seed({ id: "dep", title: "deploy command", body: "run pnpm deploy", agent_id: "codex" });
    const result = store.startContext({ agent_id: "codex", task_summary: "deploy" });
    expect(result.memories.map((m) => m.id)).toContain("dep");
    expect(result.text).toContain("Relevant Working Context");
  });

  it("returns the empty package when there are no memories", () => {
    const { store } = setup();
    const result = store.startContext({ agent_id: "codex" });
    expect(result.memories).toEqual([]);
    // Parity with SQLite: the Identity/Relationship sections always render,
    // each with the per-section "No active memories found." line.
    expect(result.text).toContain("Identity");
    expect(result.text).toContain("No active memories found.");
  });
});
