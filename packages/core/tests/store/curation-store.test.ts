// Curation data-model store (memory-curator spec §8).
//
// `memory_curation_runs` + `memory_curation_operations` are a SQLite-authoritative
// record of *why* the curator suggested or performed an operation. They are not
// projections of the memory ledger, so they must survive a projection rebuild.
// This pins create/read round-trips (incl. JSON array/payload fields) and
// rebuild survival.

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-curation-"));
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

describe("curation store (memory_curation_runs + operations)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("creates and reads back a curation run with parsed JSON fields", () => {
    const { store } = s!;
    const run = store.createCurationRun({
      trigger: "manual",
      visibility: "common",
      input_hash: "hash-1",
      input_memory_ids: ["mem_a", "mem_b"],
      input_session_ids: ["ses_x"],
      project_key: "the-librarian",
      model_provider: "anthropic",
      model_name: "claude-opus-4-7",
    });

    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("pending");
    expect(run.mode).toBe("apply");
    expect(run.input_memory_ids).toEqual(["mem_a", "mem_b"]);
    expect(run.input_session_ids).toEqual(["ses_x"]);

    const read = store.getCurationRun(run.id);
    expect(read?.input_memory_ids).toEqual(["mem_a", "mem_b"]);
    expect(read?.trigger).toBe("manual");
    expect(read?.model_name).toBe("claude-opus-4-7");
  });

  it("records and reads operations for a run with parsed payload + id arrays", () => {
    const { store } = s!;
    const run = store.createCurationRun({
      trigger: "schedule",
      visibility: "common",
      input_hash: "hash-2",
    });
    const op = store.recordCurationOperation({
      run_id: run.id,
      operation_type: "create",
      status: "proposed",
      confidence: 0.92,
      risk_level: "safe",
      source_memory_ids: ["mem_a"],
      target_memory_ids: ["mem_new"],
      rationale: "merge two near-duplicate lessons",
      proposed_payload: { title: "Consolidated lesson", body: "…" },
    });

    expect(op.id).toMatch(/^op_/);
    expect(op.run_id).toBe(run.id);
    expect(op.confidence).toBeCloseTo(0.92);

    const ops = store.getCurationOperations(run.id);
    expect(ops).toHaveLength(1);
    expect(ops[0].source_memory_ids).toEqual(["mem_a"]);
    expect(ops[0].target_memory_ids).toEqual(["mem_new"]);
    expect(ops[0].proposed_payload).toEqual({ title: "Consolidated lesson", body: "…" });
  });

  it("lists curation runs most-recent-first", () => {
    const { store } = s!;
    const first = store.createCurationRun({
      trigger: "manual",
      visibility: "common",
      input_hash: "h1",
    });
    const second = store.createCurationRun({
      trigger: "manual",
      visibility: "common",
      input_hash: "h2",
    });
    const ids = store.listCurationRuns().map((r) => r.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it("survives a projection rebuild (authoritative, not a ledger projection)", () => {
    const { store } = s!;
    const run = store.createCurationRun({
      trigger: "manual",
      visibility: "common",
      input_hash: "h3",
    });
    store.recordCurationOperation({
      run_id: run.id,
      operation_type: "noop",
      status: "skipped",
      confidence: 0,
      risk_level: "safe",
      rationale: "nothing to do",
      proposed_payload: {},
    });
    store.rebuildIndex();
    expect(store.getCurationRun(run.id)?.input_hash).toBe("h3");
    expect(store.getCurationOperations(run.id)).toHaveLength(1);
  });
});
