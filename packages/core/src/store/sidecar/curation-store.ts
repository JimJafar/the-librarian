// JSON sidecar curation store (plan 036 Phase 4). The curator's run + operation
// bookkeeping, on a sidecar JSON file OUTSIDE the git vault — bookkeeping, not
// durable knowledge. Run-history reads (the §10.1 running-run lock) are served
// directly off the JSON runs.
//
// Whole-file read/write per op (fine at the curator's once-a-day-per-slice
// cadence — tens of runs, not thousands). The run lifecycle guards: start
// COALESCEs started_at; complete/fail only transition a NON-terminal run (so a
// reclaimed→failed run can't be resurrected, §10.1).
//
// `findRunningRun` provides the §10.1 slice lock the enqueue loop needs. The
// per-slice interval due-check (the old CurationRunReader/selectDueSlices seam) is
// retired (spec 045 D-3a); idempotency now decides which slices do work.

import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "../../constants.js";
import {
  type GroomingMemorySource,
  type EvidenceSlice,
  type MemoryEvidenceBundle,
  type MemoryEvidenceCaps,
  gatherMemoryEvidence as gatherMemoryEvidenceImpl,
} from "../../grooming-evidence.js";
import type {
  CompleteCurationRunInput,
  CreateCurationRunInput,
  CurationOperation,
  CurationRun,
  CurationStore,
  FailCurationRunInput,
  ListCurationRunsInput,
  RecordCurationOperationInput,
} from "../curation-store.js";

interface CurationData {
  runs: Record<string, CurationRun>;
  operations: Record<string, CurationOperation>;
}

export interface JsonCurationStoreDeps {
  /** Sidecar file path, outside the git vault (e.g. `<data-dir>/curation-runs.json`). */
  filePath: string;
  /** Memory-evidence reads (slices + active/proposed/archived per slice), vault-backed. */
  memorySource: GroomingMemorySource;
  now?: () => string;
  generateId?: () => string;
}

const TERMINAL = new Set(["completed", "failed"]);

// Slice membership predicate — a run belongs to a slice.
function matchesSlice(run: CurationRun, slice: EvidenceSlice): boolean {
  switch (slice.kind) {
    case "common_global":
      return run.visibility === "common" && run.project_key === null;
    case "common_project":
      return run.visibility === "common" && run.project_key === (slice.projectKey ?? "");
    case "agent_private":
      return run.visibility === "agent_private" && run.agent_id === (slice.agentId ?? "");
  }
}

// Newest-first by created_at, id as a deterministic tiebreak.
function byCreatedDesc(a: CurationRun, b: CurationRun): number {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

export function createJsonCurationStore(deps: JsonCurationStoreDeps): CurationStore {
  const { filePath, memorySource } = deps;
  const now = deps.now ?? nowIso;
  const newRunId = deps.generateId ?? (() => makeId("run"));

  function readAll(): CurationData {
    if (!fs.existsSync(filePath)) return { runs: {}, operations: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CurationData>;
      return {
        runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {},
        operations:
          parsed.operations && typeof parsed.operations === "object" ? parsed.operations : {},
      };
    } catch {
      // Corrupt file → start fresh. Curation runs are advisory scheduling
      // bookkeeping (the apply path has its own idempotency), not durable
      // knowledge, so degrading-to-empty mirrors the other sidecars.
      return { runs: {}, operations: {} };
    }
  }

  function writeAll(data: CurationData): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  function createCurationRun(input: CreateCurationRunInput): CurationRun {
    const id = newRunId();
    const run: CurationRun = {
      id,
      status: input.status ?? "pending",
      trigger: input.trigger,
      mode: input.mode ?? "apply",
      project_key: input.project_key ?? null,
      visibility: input.visibility,
      agent_id: input.agent_id ?? null,
      input_hash: input.input_hash,
      input_memory_ids: input.input_memory_ids ?? [],
      model_provider: input.model_provider ?? null,
      model_name: input.model_name ?? null,
      usage_input_tokens: 0,
      usage_output_tokens: 0,
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

  function getCurationRun(id: string): CurationRun | null {
    return readAll().runs[id] ?? null;
  }

  function findCompletedApplyRun(inputHash: string): CurationRun | null {
    // Only completed APPLY runs satisfy idempotency; dry-runs + in-flight runs
    // must not suppress a real run (§10.2).
    const matches = Object.values(readAll().runs)
      .filter((r) => r.input_hash === inputHash && r.mode === "apply" && r.status === "completed")
      .sort(byCreatedDesc);
    return matches[0] ?? null;
  }

  function listCurationRuns(input: ListCurationRunsInput = {}): CurationRun[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    return Object.values(readAll().runs)
      .filter((r) => (input.status ? r.status === input.status : true))
      .filter((r) => (input.trigger ? r.trigger === input.trigger : true))
      .sort(byCreatedDesc)
      .slice(0, limit);
  }

  function recordCurationOperation(input: RecordCurationOperationInput): CurationOperation {
    const id = makeId("op");
    const operation: CurationOperation = {
      id,
      run_id: input.run_id,
      operation_type: input.operation_type,
      status: input.status,
      confidence: input.confidence,
      risk_level: input.risk_level,
      source_memory_ids: input.source_memory_ids ?? [],
      target_memory_ids: input.target_memory_ids ?? [],
      title: input.title ?? null,
      rationale: input.rationale,
      proposed_payload: input.proposed_payload ?? {},
      applied_at: null,
      error: null,
    };
    const data = readAll();
    data.operations[id] = operation;
    writeAll(data);
    return operation;
  }

  function getCurationOperations(runId: string): CurationOperation[] {
    return Object.values(readAll().operations)
      .filter((op) => op.run_id === runId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function requireRun(id: string): CurationRun {
    const run = getCurationRun(id);
    if (!run) throw new Error(`No curation run found for id ${id}`);
    return run;
  }

  function startCurationRun(id: string): CurationRun {
    const data = readAll();
    const run = data.runs[id];
    if (!run) throw new Error(`No curation run found for id ${id}`);
    run.status = "running";
    run.started_at = run.started_at ?? now(); // COALESCE — keep the original on restart
    writeAll(data);
    return run;
  }

  function completeCurationRun(id: string, input: CompleteCurationRunInput = {}): CurationRun {
    const data = readAll();
    const run = data.runs[id];
    if (!run) throw new Error(`No curation run found for id ${id}`);
    // Only a non-terminal run transitions — a reclaimed→failed run can't be
    // resurrected by a late completion (§10.1).
    if (!TERMINAL.has(run.status)) {
      run.status = "completed";
      run.completed_at = now();
      run.summary = input.summary ?? null;
      run.usage_input_tokens = input.usage_input_tokens ?? 0;
      run.usage_output_tokens = input.usage_output_tokens ?? 0;
      writeAll(data);
    }
    return requireRun(id);
  }

  function failCurationRun(id: string, input: FailCurationRunInput): CurationRun {
    const data = readAll();
    const run = data.runs[id];
    if (!run) throw new Error(`No curation run found for id ${id}`);
    if (!TERMINAL.has(run.status)) {
      run.status = "failed";
      run.completed_at = now();
      run.error = input.error;
      writeAll(data);
    }
    return requireRun(id);
  }

  // The §10.1 slice lock: the latest RUNNING run for a slice. runDueCuration
  // compares its startedAt against a TTL to tell an active lock from a stale
  // (crashed-worker) one to reclaim. (The per-slice interval gate was retired in
  // spec 045 D-3a, so the old lastCompletedRunAt due-check seam is gone.)
  function findRunningRun(slice: EvidenceSlice): { id: string; startedAt: Date } | null {
    const running = Object.values(readAll().runs).filter(
      (r) => matchesSlice(r, slice) && r.status === "running" && r.started_at,
    );
    if (running.length === 0) return null;
    const latest = running.reduce((a, b) =>
      (a.started_at as string) >= (b.started_at as string) ? a : b,
    );
    return { id: latest.id, startedAt: new Date(latest.started_at as string) };
  }

  function gatherMemoryEvidence(
    slice: EvidenceSlice,
    caps: MemoryEvidenceCaps,
  ): MemoryEvidenceBundle {
    return gatherMemoryEvidenceImpl(memorySource, slice, caps);
  }

  return {
    createCurationRun,
    getCurationRun,
    findCompletedApplyRun,
    listCurationRuns,
    recordCurationOperation,
    getCurationOperations,
    startCurationRun,
    completeCurationRun,
    failCurationRun,
    gatherMemoryEvidence,
    listGroomingSlices: () => memorySource.listSlices(),
    findRunningRun: (slice: EvidenceSlice) => findRunningRun(slice),
  };
}
