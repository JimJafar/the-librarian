// JSON sidecar intake (intake) store (spec 043 C1). The intake pipeline's
// full-outcome decision log, paralleling grooming's `createJsonCurationStore` /
// `curation-runs.json`. Records, on a sidecar JSON file OUTSIDE the git vault, one
// run per sweep + one operation row per filed item (action + outcome + confidence
// + rationale + source/target id). Purely observational — the intake reads
// nothing back from here, so a write failure never changes filing (the callers
// wrap every write fail-soft; see sweep.ts / apply.ts).
//
// Same idioms as the curation sidecar: whole-file read/write per op (sweeps are
// serial + low-cadence), corrupt-file degrades to empty, and the run lifecycle
// guards mirror it exactly — start COALESCEs started_at; complete/fail only
// transition a NON-terminal run so a late call can't resurrect a terminal run.

import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "../../constants.js";
import type {
  CompleteIntakeRunInput,
  IntakeOperation,
  IntakeRun,
  IntakeStore,
  CreateIntakeRunInput,
  FailIntakeRunInput,
  ListIntakeRunsInput,
  RecordIntakeOperationInput,
} from "../intake-store.js";

interface IntakeData {
  runs: Record<string, IntakeRun>;
  operations: Record<string, IntakeOperation>;
}

export interface JsonIntakeStoreDeps {
  /** Sidecar file path, outside the git vault (e.g. `<data-dir>/consolidation-runs.json`). */
  filePath: string;
  now?: () => string;
  generateId?: () => string;
}

const TERMINAL = new Set(["completed", "failed"]);

// Newest-first by created_at, id as a deterministic tiebreak (mirrors the curation
// store's `ORDER BY created_at DESC, id DESC`).
function byCreatedDesc(a: IntakeRun, b: IntakeRun): number {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

export function createJsonIntakeStore(deps: JsonIntakeStoreDeps): IntakeStore {
  const { filePath } = deps;
  const now = deps.now ?? nowIso;
  const newRunId = deps.generateId ?? (() => makeId("crun"));

  function readAll(): IntakeData {
    if (!fs.existsSync(filePath)) return { runs: {}, operations: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<IntakeData>;
      return {
        runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {},
        operations:
          parsed.operations && typeof parsed.operations === "object" ? parsed.operations : {},
      };
    } catch {
      // Corrupt file → start fresh. The decision log is advisory observability,
      // not durable knowledge (filing has its own idempotency), so degrading-to-
      // empty mirrors the curation sidecar.
      return { runs: {}, operations: {} };
    }
  }

  function writeAll(data: IntakeData): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  function createIntakeRun(input: CreateIntakeRunInput): IntakeRun {
    const id = newRunId();
    const run: IntakeRun = {
      id,
      status: input.status ?? "pending",
      trigger: input.trigger,
      consolidated: 0,
      judge_errors: 0,
      errored: 0,
      reclaimed: 0,
      summary: null,
      error: null,
      created_at: now(),
      started_at: null,
      completed_at: null,
    };
    const data = readAll();
    data.runs[id] = run;
    writeAll(data);
    return run;
  }

  function getIntakeRun(id: string): IntakeRun | null {
    return readAll().runs[id] ?? null;
  }

  function listIntakeRuns(input: ListIntakeRunsInput = {}): IntakeRun[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    return Object.values(readAll().runs)
      .filter((r) => (input.status ? r.status === input.status : true))
      .filter((r) => (input.trigger ? r.trigger === input.trigger : true))
      .sort(byCreatedDesc)
      .slice(0, limit);
  }

  function recordIntakeOperation(input: RecordIntakeOperationInput): IntakeOperation {
    const id = makeId("cop");
    const operation: IntakeOperation = {
      id,
      run_id: input.run_id,
      action: input.action,
      outcome: input.outcome,
      confidence: input.confidence,
      rationale: input.rationale,
      source_id: input.source_id ?? null,
      target_id: input.target_id ?? null,
    };
    const data = readAll();
    data.operations[id] = operation;
    writeAll(data);
    return operation;
  }

  function getIntakeOperations(runId: string): IntakeOperation[] {
    return Object.values(readAll().operations)
      .filter((op) => op.run_id === runId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function countAppliedOperationsSince(sinceIso: string | null): number {
    const { runs, operations } = readAll();
    // An op's time is its owning run's created_at (ops carry no timestamp; the sweep
    // that produced them is the natural time unit, and grooming is enqueued only
    // AFTER a sweep's log is written, so the run boundary is clean — no double-count
    // and no off-by-one at the groom timestamp, which we exclude via strict `>`).
    return Object.values(operations).filter((op) => {
      if (op.outcome !== "applied") return false;
      const createdAt = runs[op.run_id]?.created_at;
      if (createdAt === undefined) return false; // orphan op (run pruned) — don't count
      return sinceIso === null || createdAt > sinceIso;
    }).length;
  }

  function requireRun(id: string): IntakeRun {
    const run = getIntakeRun(id);
    if (!run) throw new Error(`No intake run found for id ${id}`);
    return run;
  }

  function startIntakeRun(id: string): IntakeRun {
    const data = readAll();
    const run = data.runs[id];
    if (!run) throw new Error(`No intake run found for id ${id}`);
    run.status = "running";
    run.started_at = run.started_at ?? now(); // COALESCE — keep the original on restart
    writeAll(data);
    return run;
  }

  function completeIntakeRun(id: string, input: CompleteIntakeRunInput = {}): IntakeRun {
    const data = readAll();
    const run = data.runs[id];
    if (!run) throw new Error(`No intake run found for id ${id}`);
    // Only a non-terminal run transitions — a failed run can't be resurrected by a
    // late completion (mirrors the curation store §10.1 guard).
    if (!TERMINAL.has(run.status)) {
      run.status = "completed";
      run.completed_at = now();
      run.summary = input.summary ?? null;
      run.consolidated = input.consolidated ?? 0;
      run.judge_errors = input.judge_errors ?? 0;
      run.errored = input.errored ?? 0;
      run.reclaimed = input.reclaimed ?? 0;
      writeAll(data);
    }
    return requireRun(id);
  }

  function failIntakeRun(id: string, input: FailIntakeRunInput): IntakeRun {
    const data = readAll();
    const run = data.runs[id];
    if (!run) throw new Error(`No intake run found for id ${id}`);
    if (!TERMINAL.has(run.status)) {
      run.status = "failed";
      run.completed_at = now();
      run.error = input.error;
      writeAll(data);
    }
    return requireRun(id);
  }

  return {
    createIntakeRun,
    getIntakeRun,
    listIntakeRuns,
    recordIntakeOperation,
    getIntakeOperations,
    countAppliedOperationsSince,
    startIntakeRun,
    completeIntakeRun,
    failIntakeRun,
  };
}
