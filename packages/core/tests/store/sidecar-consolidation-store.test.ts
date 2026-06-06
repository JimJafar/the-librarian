// JSON sidecar consolidation (intake) store (spec 043 C1). Mirrors the curation
// sidecar test: run + operation round-trips, the run lifecycle guards (start
// COALESCEs started_at; complete/fail only transition a non-terminal run),
// corrupt-file degrade-to-empty, list filtering/ordering, and cross-instance
// durability.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CreateConsolidationRunInput,
  type RecordConsolidationOperationInput,
  createJsonConsolidationStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir = "";
let tick = 0;
const clock = () => `2026-06-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;

function makeStore() {
  return createJsonConsolidationStore({
    filePath: path.join(dir, "consolidation-runs.json"),
    now: clock,
  });
}

const run = (over: Partial<CreateConsolidationRunInput> = {}): CreateConsolidationRunInput => ({
  trigger: "tick",
  ...over,
});

const op = (
  over: Partial<RecordConsolidationOperationInput> = {},
): RecordConsolidationOperationInput => ({
  run_id: "r1",
  action: "create",
  outcome: "applied",
  confidence: 0.97,
  rationale: "novel topic",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-sidecar-consolidation-"));
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createJsonConsolidationStore — runs + operations", () => {
  it("creates and reads back a run with defaulted counters", () => {
    const store = makeStore();
    const created = store.createConsolidationRun(run({ trigger: "boot" }));
    expect(created).toMatchObject({
      trigger: "boot",
      status: "pending",
      consolidated: 0,
      judge_errors: 0,
      errored: 0,
      reclaimed: 0,
      summary: null,
      error: null,
      started_at: null,
      completed_at: null,
    });
    expect(store.getConsolidationRun(created.id)).toEqual(created);
  });

  it("records full-outcome operations (applied | proposed | skipped | failed)", () => {
    const store = makeStore();
    const r = store.createConsolidationRun(run());
    store.recordConsolidationOperation(op({ run_id: r.id, outcome: "applied", action: "create" }));
    store.recordConsolidationOperation(
      op({ run_id: r.id, outcome: "proposed", action: "augment", target_id: "m1" }),
    );
    store.recordConsolidationOperation(op({ run_id: r.id, outcome: "skipped", action: "noop" }));
    store.recordConsolidationOperation(
      op({ run_id: r.id, outcome: "failed", action: "supersede", target_id: "m2" }),
    );

    const ops = store.getConsolidationOperations(r.id);
    expect(ops).toHaveLength(4);
    expect(ops.map((o) => o.outcome).sort()).toEqual(["applied", "failed", "proposed", "skipped"]);
    const augment = ops.find((o) => o.action === "augment");
    expect(augment).toMatchObject({ outcome: "proposed", target_id: "m1", source_id: null });
  });

  it("carries source_id + target_id through, defaulting absent ids to null", () => {
    const store = makeStore();
    const r = store.createConsolidationRun(run());
    store.recordConsolidationOperation(
      op({ run_id: r.id, source_id: "inbox/x.md", target_id: "mem_1" }),
    );
    const [stored] = store.getConsolidationOperations(r.id);
    expect(stored).toMatchObject({ source_id: "inbox/x.md", target_id: "mem_1" });
  });

  it("start COALESCEs started_at across restarts", () => {
    const store = makeStore();
    const r = store.createConsolidationRun(run());
    const first = store.startConsolidationRun(r.id);
    expect(first.status).toBe("running");
    expect(first.started_at).not.toBeNull();
    const again = store.startConsolidationRun(r.id);
    expect(again.started_at).toBe(first.started_at); // original kept
  });

  it("complete records the summary + counters and transitions to completed", () => {
    const store = makeStore();
    const r = store.createConsolidationRun(run());
    store.startConsolidationRun(r.id);
    const done = store.completeConsolidationRun(r.id, {
      summary: "consolidated 2",
      consolidated: 2,
      judge_errors: 1,
      errored: 0,
      reclaimed: 3,
    });
    expect(done).toMatchObject({
      status: "completed",
      summary: "consolidated 2",
      consolidated: 2,
      judge_errors: 1,
      reclaimed: 3,
    });
    expect(done.completed_at).not.toBeNull();
  });

  it("complete/fail only transition a NON-terminal run (no resurrection)", () => {
    const store = makeStore();
    const r = store.createConsolidationRun(run());
    store.failConsolidationRun(r.id, { error: "boom" });
    // A late completion can't resurrect a failed run.
    const after = store.completeConsolidationRun(r.id, { summary: "late" });
    expect(after.status).toBe("failed");
    expect(after.summary).toBeNull();
    expect(after.error).toBe("boom");
  });

  it("lists runs newest-first and filters by status/trigger", () => {
    const store = makeStore();
    const a = store.createConsolidationRun(run({ trigger: "boot" }));
    const b = store.createConsolidationRun(run({ trigger: "tick" }));
    store.completeConsolidationRun(b.id, { summary: "done" });

    const all = store.listConsolidationRuns();
    expect(all[0]?.id).toBe(b.id); // newest first (created later)
    expect(all.map((r) => r.id)).toContain(a.id);

    expect(store.listConsolidationRuns({ trigger: "boot" }).map((r) => r.id)).toEqual([a.id]);
    expect(store.listConsolidationRuns({ status: "completed" }).map((r) => r.id)).toEqual([b.id]);
  });

  it("degrades a corrupt sidecar file to empty rather than throwing", () => {
    const filePath = path.join(dir, "consolidation-runs.json");
    fs.writeFileSync(filePath, "{ not json", "utf8");
    const store = createJsonConsolidationStore({ filePath, now: clock });
    expect(store.listConsolidationRuns()).toEqual([]);
    // and a fresh write still works
    const r = store.createConsolidationRun(run());
    expect(store.getConsolidationRun(r.id)).not.toBeNull();
  });

  it("persists across store instances (sidecar durability)", () => {
    const filePath = path.join(dir, "consolidation-runs.json");
    const a = createJsonConsolidationStore({ filePath, now: clock });
    const r = a.createConsolidationRun(run());
    a.recordConsolidationOperation(op({ run_id: r.id }));

    const b = createJsonConsolidationStore({ filePath, now: clock });
    expect(b.getConsolidationRun(r.id)?.id).toBe(r.id);
    expect(b.getConsolidationOperations(r.id)).toHaveLength(1);
  });
});
