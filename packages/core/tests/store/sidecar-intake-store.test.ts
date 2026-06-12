// JSON sidecar intake (intake) store (spec 043 C1). Mirrors the curation
// sidecar test: run + operation round-trips, the run lifecycle guards (start
// COALESCEs started_at; complete/fail only transition a non-terminal run),
// corrupt-file degrade-to-empty, list filtering/ordering, and cross-instance
// durability.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CreateIntakeRunInput,
  type RecordIntakeOperationInput,
  createJsonIntakeStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir = "";
let tick = 0;
const clock = () => `2026-06-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;

function makeStore() {
  return createJsonIntakeStore({
    filePath: path.join(dir, "intake-runs.json"),
    now: clock,
  });
}

const run = (over: Partial<CreateIntakeRunInput> = {}): CreateIntakeRunInput => ({
  trigger: "tick",
  ...over,
});

const op = (over: Partial<RecordIntakeOperationInput> = {}): RecordIntakeOperationInput => ({
  run_id: "r1",
  action: "create",
  outcome: "applied",
  confidence: 0.97,
  rationale: "novel topic",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-sidecar-intake-"));
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createJsonIntakeStore — runs + operations", () => {
  it("creates and reads back a run with defaulted counters", () => {
    const store = makeStore();
    const created = store.createIntakeRun(run({ trigger: "boot" }));
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
    expect(store.getIntakeRun(created.id)).toEqual(created);
  });

  it("records full-outcome operations (applied | proposed | skipped | failed)", () => {
    const store = makeStore();
    const r = store.createIntakeRun(run());
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "applied", action: "create" }));
    store.recordIntakeOperation(
      op({ run_id: r.id, outcome: "proposed", action: "augment", target_id: "m1" }),
    );
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "skipped", action: "noop" }));
    store.recordIntakeOperation(
      op({ run_id: r.id, outcome: "failed", action: "supersede", target_id: "m2" }),
    );

    const ops = store.getIntakeOperations(r.id);
    expect(ops).toHaveLength(4);
    expect(ops.map((o) => o.outcome).sort()).toEqual(["applied", "failed", "proposed", "skipped"]);
    const augment = ops.find((o) => o.action === "augment");
    expect(augment).toMatchObject({ outcome: "proposed", target_id: "m1", source_id: null });
  });

  it("carries source_id + target_id through, defaulting absent ids to null", () => {
    const store = makeStore();
    const r = store.createIntakeRun(run());
    store.recordIntakeOperation(op({ run_id: r.id, source_id: "inbox/x.md", target_id: "mem_1" }));
    const [stored] = store.getIntakeOperations(r.id);
    expect(stored).toMatchObject({ source_id: "inbox/x.md", target_id: "mem_1" });
  });

  it("start COALESCEs started_at across restarts", () => {
    const store = makeStore();
    const r = store.createIntakeRun(run());
    const first = store.startIntakeRun(r.id);
    expect(first.status).toBe("running");
    expect(first.started_at).not.toBeNull();
    const again = store.startIntakeRun(r.id);
    expect(again.started_at).toBe(first.started_at); // original kept
  });

  it("complete records the summary + counters and transitions to completed", () => {
    const store = makeStore();
    const r = store.createIntakeRun(run());
    store.startIntakeRun(r.id);
    const done = store.completeIntakeRun(r.id, {
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
    const r = store.createIntakeRun(run());
    store.failIntakeRun(r.id, { error: "boom" });
    // A late completion can't resurrect a failed run.
    const after = store.completeIntakeRun(r.id, { summary: "late" });
    expect(after.status).toBe("failed");
    expect(after.summary).toBeNull();
    expect(after.error).toBe("boom");
  });

  it("lists runs newest-first and filters by status/trigger", () => {
    const store = makeStore();
    const a = store.createIntakeRun(run({ trigger: "boot" }));
    const b = store.createIntakeRun(run({ trigger: "tick" }));
    store.completeIntakeRun(b.id, { summary: "done" });

    const all = store.listIntakeRuns();
    expect(all[0]?.id).toBe(b.id); // newest first (created later)
    expect(all.map((r) => r.id)).toContain(a.id);

    expect(store.listIntakeRuns({ trigger: "boot" }).map((r) => r.id)).toEqual([a.id]);
    expect(store.listIntakeRuns({ status: "completed" }).map((r) => r.id)).toEqual([b.id]);
  });

  it("degrades a corrupt sidecar file to empty rather than throwing", () => {
    const filePath = path.join(dir, "intake-runs.json");
    fs.writeFileSync(filePath, "{ not json", "utf8");
    const store = createJsonIntakeStore({ filePath, now: clock });
    expect(store.listIntakeRuns()).toEqual([]);
    // and a fresh write still works
    const r = store.createIntakeRun(run());
    expect(store.getIntakeRun(r.id)).not.toBeNull();
  });

  // ── countAppliedOperationsSince — drives the post-intake groom trigger (043 D-A) ──

  it("counts only APPLIED ops, ignoring proposed/skipped/failed", () => {
    const store = makeStore();
    const r = store.createIntakeRun(run());
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "applied" }));
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "applied" }));
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "proposed" }));
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "skipped" }));
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "failed" }));

    expect(store.countAppliedOperationsSince(null)).toBe(2);
  });

  it("counts ops only from runs created strictly AFTER the cutoff (no off-by-one at the boundary)", () => {
    const store = makeStore();
    // The clock advances per write; capture the boundary between two runs.
    const before = store.createIntakeRun(run()); // created_at tick 0
    store.recordIntakeOperation(op({ run_id: before.id, outcome: "applied" }));
    const boundary = before.created_at; // = the groom's reference timestamp
    const after = store.createIntakeRun(run()); // created later than `boundary`
    store.recordIntakeOperation(op({ run_id: after.id, outcome: "applied" }));
    store.recordIntakeOperation(op({ run_id: after.id, outcome: "applied" }));

    // Strictly-after: the op in `before` (created AT the boundary) is excluded.
    expect(store.countAppliedOperationsSince(boundary)).toBe(2);
    // A null cutoff counts everything.
    expect(store.countAppliedOperationsSince(null)).toBe(3);
  });

  it("returns 0 when nothing applied since the cutoff", () => {
    const store = makeStore();
    const r = store.createIntakeRun(run());
    store.recordIntakeOperation(op({ run_id: r.id, outcome: "applied" }));
    // Cutoff in the future → no run is strictly after it.
    expect(store.countAppliedOperationsSince("2099-01-01T00:00:00.000Z")).toBe(0);
  });

  it("persists across store instances (sidecar durability)", () => {
    const filePath = path.join(dir, "intake-runs.json");
    const a = createJsonIntakeStore({ filePath, now: clock });
    const r = a.createIntakeRun(run());
    a.recordIntakeOperation(op({ run_id: r.id }));

    const b = createJsonIntakeStore({ filePath, now: clock });
    expect(b.getIntakeRun(r.id)?.id).toBe(r.id);
    expect(b.getIntakeOperations(r.id)).toHaveLength(1);
  });
});
