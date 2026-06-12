// JSON sidecar curation store (plan 036 Phase 4). The CurationStore contract
// on a sidecar JSON file: run +
// operation round-trips, the run lifecycle guards (start COALESCEs started_at;
// complete/fail only transition a non-terminal run), findCompletedApplyRun
// idempotency, the §10.1 running-run lock slice-matching, the full slice listing,
// and cross-instance durability. (The per-slice interval selectDueSlices seam is
// retired in plan 046 T4 — a pass attempts every slice, idempotency gates work.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CreateCurationRunInput,
  type GroomingMemorySource,
  type EvidenceSlice,
  createJsonCurationStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SLICES: EvidenceSlice[] = [
  { kind: "common_global" },
  { kind: "common_project", projectKey: "proj-x" },
  { kind: "agent_private", agentId: "agent-a" },
];

function fakeSource(slices: EvidenceSlice[] = SLICES): GroomingMemorySource {
  return { listSlices: () => slices, selectMemories: () => [], selectTombstones: () => [] };
}

let dir = "";
let tick = 0;
const clock = () => `2026-06-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;

function makeStore(source: GroomingMemorySource = fakeSource()) {
  return createJsonCurationStore({
    filePath: path.join(dir, "curation-runs.json"),
    memorySource: source,
    now: clock,
  });
}

const run = (over: Partial<CreateCurationRunInput> = {}): CreateCurationRunInput => ({
  trigger: "schedule",
  visibility: "common",
  input_hash: "h1",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-sidecar-curation-"));
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createJsonCurationStore — runs + operations", () => {
  it("creates and reads back a run with parsed array fields", () => {
    const store = makeStore();
    const created = store.createCurationRun(
      run({ project_key: "proj-x", input_memory_ids: ["m1", "m2"] }),
    );
    expect(created).toMatchObject({
      status: "pending",
      trigger: "schedule",
      mode: "apply",
      project_key: "proj-x",
      visibility: "common",
      input_memory_ids: ["m1", "m2"],
      usage_input_tokens: 0,
      started_at: null,
      completed_at: null,
    });
    expect(store.getCurationRun(created.id)).toEqual(created);
    expect(store.getCurationRun("run_ghost")).toBeNull();
  });

  it("records and reads operations for a run", () => {
    const store = makeStore();
    const r = store.createCurationRun(run());
    const op = store.recordCurationOperation({
      run_id: r.id,
      operation_type: "create",
      status: "proposed",
      confidence: 0.9,
      risk_level: "normal",
      rationale: "because",
      proposed_payload: { title: "t" },
      source_memory_ids: ["s1"],
    });
    expect(store.getCurationOperations(r.id)).toEqual([op]);
    expect(op.proposed_payload).toEqual({ title: "t" });
    expect(op.source_memory_ids).toEqual(["s1"]);
    expect(op.target_memory_ids).toEqual([]);
  });

  it("returns operations ordered by id", () => {
    const store = makeStore();
    const r = store.createCurationRun(run());
    const base = {
      run_id: r.id,
      operation_type: "noop",
      status: "skipped",
      confidence: 1,
      risk_level: "safe",
      rationale: "r",
      proposed_payload: {},
    } as const;
    const ids = [
      store.recordCurationOperation(base).id,
      store.recordCurationOperation(base).id,
      store.recordCurationOperation(base).id,
    ];
    expect(store.getCurationOperations(r.id).map((op) => op.id)).toEqual([...ids].sort());
  });

  it("lists runs most-recent-first, honouring status/trigger filters + the limit", () => {
    const store = makeStore();
    const a = store.createCurationRun(run({ input_hash: "ha" }));
    const b = store.createCurationRun(run({ input_hash: "hb", trigger: "manual" }));
    expect(store.listCurationRuns().map((r) => r.id)).toEqual([b.id, a.id]); // newest first
    expect(store.listCurationRuns({ trigger: "manual" }).map((r) => r.id)).toEqual([b.id]);
    expect(store.listCurationRuns({ limit: 1 }).map((r) => r.id)).toEqual([b.id]);
  });
});

describe("createJsonCurationStore — run lifecycle", () => {
  it("starts a run: running + started_at, idempotent on started_at", () => {
    const store = makeStore();
    const r = store.createCurationRun(run());
    const started = store.startCurationRun(r.id);
    expect(started.status).toBe("running");
    expect(started.started_at).not.toBeNull();
    const restarted = store.startCurationRun(r.id);
    expect(restarted.started_at).toBe(started.started_at); // COALESCE keeps the original
  });

  it("completes a run with summary + token usage", () => {
    const store = makeStore();
    const r = store.createCurationRun(run());
    store.startCurationRun(r.id);
    const done = store.completeCurationRun(r.id, {
      summary: "ok",
      usage_input_tokens: 12,
      usage_output_tokens: 7,
    });
    expect(done).toMatchObject({ status: "completed", summary: "ok", usage_input_tokens: 12 });
    expect(done.completed_at).not.toBeNull();
  });

  it("fails a run with an error + completed_at", () => {
    const store = makeStore();
    const r = store.createCurationRun(run());
    store.startCurationRun(r.id);
    const failed = store.failCurationRun(r.id, { error: "llm_error: timeout" });
    expect(failed).toMatchObject({ status: "failed", error: "llm_error: timeout" });
    expect(failed.completed_at).not.toBeNull();
  });

  it("a terminal run cannot be resurrected by a late completion (§10.1)", () => {
    const store = makeStore();
    const r = store.createCurationRun(run());
    store.startCurationRun(r.id);
    store.failCurationRun(r.id, { error: "stale_lock_reclaimed" });
    const after = store.completeCurationRun(r.id, { summary: "done", usage_input_tokens: 9 });
    expect(after.status).toBe("failed"); // not resurrected
    expect(after.summary).toBeNull();
  });

  it("throws for an unknown run id", () => {
    const store = makeStore();
    expect(() => store.startCurationRun("run_ghost")).toThrow(/run/i);
  });

  it("findCompletedApplyRun matches only completed apply-mode runs", () => {
    const store = makeStore();
    const dry = store.createCurationRun(run({ mode: "dry_run", input_hash: "h2" }));
    store.completeCurationRun(dry.id);
    expect(store.findCompletedApplyRun("h2")).toBeNull(); // not apply mode

    const r = store.createCurationRun(run({ mode: "apply", input_hash: "h3" }));
    expect(store.findCompletedApplyRun("h3")).toBeNull(); // not completed yet
    store.completeCurationRun(r.id);
    expect(store.findCompletedApplyRun("h3")?.id).toBe(r.id);
  });
});

describe("createJsonCurationStore — slice listing (the grooming-pass seam)", () => {
  it("lists the full slice set from the memory source (no interval filter)", () => {
    const store = makeStore();
    // A grooming pass attempts every slice (spec 045 D-3a); the store simply
    // surfaces the memory source's slices — there is no per-slice due-check.
    expect(store.listGroomingSlices()).toEqual(SLICES);
  });
});

describe("createJsonCurationStore — run reader (the lock seam)", () => {
  it("finds the running run for the matching slice only", () => {
    const store = makeStore();
    const g = store.createCurationRun(run({ visibility: "common", project_key: null }));
    store.startCurationRun(g.id);
    expect(store.findRunningRun({ kind: "common_global" })?.id).toBe(g.id);
    expect(store.findRunningRun({ kind: "common_project", projectKey: "proj-x" })).toBeNull();
    expect(store.findRunningRun({ kind: "agent_private", agentId: "agent-a" })).toBeNull();

    store.completeCurationRun(g.id);
    expect(store.findRunningRun({ kind: "common_global" })).toBeNull(); // no longer running
  });

  it("matches an agent_private run by agent_id", () => {
    const store = makeStore();
    const p = store.createCurationRun(run({ visibility: "agent_private", agent_id: "agent-a" }));
    store.startCurationRun(p.id);
    expect(store.findRunningRun({ kind: "agent_private", agentId: "agent-a" })?.id).toBe(p.id);
    expect(store.findRunningRun({ kind: "agent_private", agentId: "agent-b" })).toBeNull();
  });
});

describe("createJsonCurationStore — durability", () => {
  it("a fresh store over the same file sees prior runs + operations", () => {
    const first = makeStore();
    const r = first.createCurationRun(run({ input_hash: "persist" }));
    first.completeCurationRun(r.id);
    first.recordCurationOperation({
      run_id: r.id,
      operation_type: "noop",
      status: "skipped",
      confidence: 1,
      risk_level: "safe",
      rationale: "r",
      proposed_payload: {},
    });

    const reopened = makeStore();
    expect(reopened.getCurationRun(r.id)?.status).toBe("completed");
    expect(reopened.findCompletedApplyRun("persist")?.id).toBe(r.id);
    expect(reopened.getCurationOperations(r.id)).toHaveLength(1);
  });

  it("degrades to empty on a corrupt file rather than throwing", () => {
    fs.writeFileSync(path.join(dir, "curation-runs.json"), "{not valid json", "utf8");
    const store = makeStore();
    expect(store.listCurationRuns()).toEqual([]);
    // …and recovers: a fresh write over the corrupt file succeeds.
    const r = store.createCurationRun(run());
    expect(store.getCurationRun(r.id)?.id).toBe(r.id);
  });
});
