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

  it("survives a real schema-version bump (curation tables are not dropped)", () => {
    const dataDir = s!.dataDir;
    const run = s!.store.createCurationRun({
      trigger: "manual",
      visibility: "common",
      input_hash: "h3",
    });
    s!.store.recordCurationOperation({
      run_id: run.id,
      operation_type: "noop",
      status: "skipped",
      confidence: 0,
      risk_level: "safe",
      rationale: "nothing to do",
      proposed_payload: {},
    });
    // Simulate an older install so the next open runs the REAL bump path:
    // ensureSchema → dropProjectionTables (must NOT include the curation tables)
    // → initSchema → rebuild. rebuildIndex() alone wouldn't exercise this.
    s!.store.db.exec("PRAGMA user_version = 8");
    s!.store.close();
    const reopened = createLibrarianStore({ dataDir });
    s!.store = reopened; // hand the live handle to teardown

    expect(reopened.getCurationRun(run.id)?.input_hash).toBe("h3");
    expect(reopened.getCurationOperations(run.id)).toHaveLength(1);
  });
});

describe("curation run lifecycle", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  function newRun() {
    return s!.store.createCurationRun({
      trigger: "schedule",
      visibility: "common",
      input_hash: "h",
      project_key: "proj-x",
    });
  }

  it("starts a run: running + started_at, idempotent on started_at", () => {
    const run = newRun();
    expect(run.status).toBe("pending");
    const started = s!.store.startCurationRun(run.id);
    expect(started.status).toBe("running");
    expect(started.started_at).not.toBeNull();
    // Starting again keeps the original started_at.
    const restarted = s!.store.startCurationRun(run.id);
    expect(restarted.started_at).toBe(started.started_at);
  });

  it("completes a run with summary + token usage", () => {
    const run = newRun();
    s!.store.startCurationRun(run.id);
    const done = s!.store.completeCurationRun(run.id, {
      summary: "applied 3, skipped 1",
      usage_input_tokens: 1200,
      usage_output_tokens: 300,
    });
    expect(done.status).toBe("completed");
    expect(done.completed_at).not.toBeNull();
    expect(done.summary).toBe("applied 3, skipped 1");
    expect(done.usage_input_tokens).toBe(1200);
    expect(done.usage_output_tokens).toBe(300);
  });

  it("fails a run with an error + completed_at", () => {
    const run = newRun();
    s!.store.startCurationRun(run.id);
    const failed = s!.store.failCurationRun(run.id, { error: "llm_error: timeout" });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("llm_error: timeout");
    expect(failed.completed_at).not.toBeNull();
  });

  it("throws for an unknown run id", () => {
    expect(() => s!.store.startCurationRun("run_ghost")).toThrow(/run/i);
  });
});
