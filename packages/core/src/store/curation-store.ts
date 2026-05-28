// Curation data-model store (memory-curator spec §8).
//
// `memory_curation_runs` + `memory_curation_operations` record *why* the
// curator suggested or performed an operation — the existing memory/event
// store stays authoritative for memory state. These tables are
// SQLite-authoritative (not ledger projections), so they survive a rebuild.
//
// This module is the create/read data-access layer. Run status transitions
// (pending → running → completed/failed) and usage accounting belong to the
// scheduler/worker (Workstream 2.4) and are added there, where the transitions
// are actually exercised.

import type { DatabaseSync } from "node:sqlite";
import { makeId, nowIso } from "../constants.js";

export interface CreateCurationRunInput {
  trigger: string; // schedule | manual | maintenance
  visibility: string; // common | agent_private
  input_hash: string;
  status?: string; // defaults to "pending"
  mode?: string; // defaults to "apply"
  project_key?: string | null;
  agent_id?: string | null; // only for agent_private slices
  input_memory_ids?: string[];
  model_provider?: string | null;
  model_name?: string | null;
}

export interface CurationRun {
  id: string;
  status: string;
  trigger: string;
  mode: string;
  project_key: string | null;
  visibility: string;
  agent_id: string | null;
  input_hash: string;
  input_memory_ids: string[];
  model_provider: string | null;
  model_name: string | null;
  usage_input_tokens: number;
  usage_output_tokens: number;
  summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface RecordCurationOperationInput {
  run_id: string;
  operation_type: string; // noop | create | update | archive | merge | split
  status: string; // proposed | applied | skipped | failed | superseded
  confidence: number;
  risk_level: string; // safe | normal | risky | protected
  rationale: string;
  proposed_payload: Record<string, unknown>;
  source_memory_ids?: string[];
  target_memory_ids?: string[];
  title?: string | null;
}

export interface CurationOperation {
  id: string;
  run_id: string;
  operation_type: string;
  status: string;
  confidence: number;
  risk_level: string;
  source_memory_ids: string[];
  target_memory_ids: string[];
  title: string | null;
  rationale: string;
  proposed_payload: Record<string, unknown>;
  applied_at: string | null;
  error: string | null;
}

export interface ListCurationRunsInput {
  status?: string;
  trigger?: string;
  /** Page size, defaulted to 50 and clamped to a 200 ceiling. */
  limit?: number;
}

export interface CompleteCurationRunInput {
  summary?: string | null;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
}

export interface FailCurationRunInput {
  /** A value-free error label (no secrets / untrusted content). */
  error: string;
}

export interface CurationStore {
  createCurationRun: (input: CreateCurationRunInput) => CurationRun;
  getCurationRun: (id: string) => CurationRun | null;
  /** Latest completed apply-mode run with this input hash, for §10.2 idempotency. */
  findCompletedApplyRun: (inputHash: string) => CurationRun | null;
  listCurationRuns: (input?: ListCurationRunsInput) => CurationRun[];
  recordCurationOperation: (input: RecordCurationOperationInput) => CurationOperation;
  getCurationOperations: (runId: string) => CurationOperation[];
  // Lifecycle transitions — direct UPDATEs on the SQLite-authoritative run row.
  startCurationRun: (id: string) => CurationRun;
  completeCurationRun: (id: string, input?: CompleteCurationRunInput) => CurationRun;
  failCurationRun: (id: string, input: FailCurationRunInput) => CurationRun;
}

interface CurationRunRow {
  id: string;
  status: string;
  trigger: string;
  mode: string;
  project_key: string | null;
  visibility: string;
  agent_id: string | null;
  input_hash: string;
  input_memory_ids: string;
  model_provider: string | null;
  model_name: string | null;
  usage_input_tokens: number;
  usage_output_tokens: number;
  summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface CurationOperationRow {
  id: string;
  run_id: string;
  operation_type: string;
  status: string;
  confidence: number;
  risk_level: string;
  source_memory_ids: string;
  target_memory_ids: string;
  title: string | null;
  rationale: string;
  proposed_payload: string;
  applied_at: string | null;
  error: string | null;
}

// Defensive parses: writes always stringify, but the worker (2.4) and any
// hand-edited row could feed malformed JSON — degrade to empty rather than throw.
function parseIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToRun(row: CurationRunRow): CurationRun {
  return {
    ...row,
    input_memory_ids: parseIds(row.input_memory_ids),
    usage_input_tokens: Number(row.usage_input_tokens || 0),
    usage_output_tokens: Number(row.usage_output_tokens || 0),
  };
}

function rowToOperation(row: CurationOperationRow): CurationOperation {
  return {
    ...row,
    confidence: Number(row.confidence || 0),
    source_memory_ids: parseIds(row.source_memory_ids),
    target_memory_ids: parseIds(row.target_memory_ids),
    proposed_payload: parsePayload(row.proposed_payload),
  };
}

export function createCurationStore(deps: { db: DatabaseSync }): CurationStore {
  const { db } = deps;

  function createCurationRun(input: CreateCurationRunInput): CurationRun {
    const id = makeId("run");
    db.prepare(
      `INSERT INTO memory_curation_runs (
        id, status, trigger, mode, project_key, visibility, agent_id, input_hash,
        input_memory_ids, model_provider, model_name,
        usage_input_tokens, usage_output_tokens, summary, error,
        created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, NULL, NULL)`,
    ).run(
      id,
      input.status ?? "pending",
      input.trigger,
      input.mode ?? "apply",
      input.project_key ?? null,
      input.visibility,
      input.agent_id ?? null,
      input.input_hash,
      JSON.stringify(input.input_memory_ids ?? []),
      input.model_provider ?? null,
      input.model_name ?? null,
      nowIso(),
    );
    const created = getCurationRun(id);
    if (!created) throw new Error(`Failed to create curation run ${id}`);
    return created;
  }

  function getCurationRun(id: string): CurationRun | null {
    const row = db.prepare("SELECT * FROM memory_curation_runs WHERE id = ?").get(id) as
      | CurationRunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  function findCompletedApplyRun(inputHash: string): CurationRun | null {
    // Only completed APPLY runs satisfy idempotency; dry-runs and in-flight runs
    // must not suppress a real run (§10.2).
    const row = db
      .prepare(
        `SELECT * FROM memory_curation_runs
         WHERE input_hash = ? AND mode = 'apply' AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(inputHash) as CurationRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  function listCurationRuns(input: ListCurationRunsInput = {}): CurationRun[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (input.status) {
      clauses.push("status = ?");
      params.push(input.status);
    }
    if (input.trigger) {
      clauses.push("trigger = ?");
      params.push(input.trigger);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = db
      .prepare(
        `SELECT * FROM memory_curation_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as CurationRunRow[];
    return rows.map(rowToRun);
  }

  function recordCurationOperation(input: RecordCurationOperationInput): CurationOperation {
    const id = makeId("op");
    db.prepare(
      `INSERT INTO memory_curation_operations (
        id, run_id, operation_type, status, confidence, risk_level,
        source_memory_ids, target_memory_ids,
        title, rationale, proposed_payload, applied_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      input.run_id,
      input.operation_type,
      input.status,
      input.confidence,
      input.risk_level,
      JSON.stringify(input.source_memory_ids ?? []),
      JSON.stringify(input.target_memory_ids ?? []),
      input.title ?? null,
      input.rationale,
      JSON.stringify(input.proposed_payload ?? {}),
    );
    const row = db.prepare("SELECT * FROM memory_curation_operations WHERE id = ?").get(id) as
      | CurationOperationRow
      | undefined;
    if (!row) throw new Error(`Failed to record curation operation ${id}`);
    return rowToOperation(row);
  }

  function getCurationOperations(runId: string): CurationOperation[] {
    const rows = db
      .prepare("SELECT * FROM memory_curation_operations WHERE run_id = ? ORDER BY id")
      .all(runId) as unknown as CurationOperationRow[];
    return rows.map(rowToOperation);
  }

  function requireRun(id: string): CurationRun {
    const run = getCurationRun(id);
    if (!run) throw new Error(`No curation run found for id ${id}`);
    return run;
  }

  function startCurationRun(id: string): CurationRun {
    // COALESCE keeps the original started_at if the run is restarted (idempotent).
    db.prepare(
      "UPDATE memory_curation_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
    ).run(nowIso(), id);
    return requireRun(id);
  }

  // complete/fail only transition a NON-terminal run, so a run already moved to a
  // terminal state (e.g. reclaimed → failed by a stale-lock sweep) cannot be
  // resurrected by a late completion from the original worker (§10.1).
  function completeCurationRun(id: string, input: CompleteCurationRunInput = {}): CurationRun {
    db.prepare(
      `UPDATE memory_curation_runs
         SET status = 'completed', completed_at = ?, summary = ?,
             usage_input_tokens = ?, usage_output_tokens = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed')`,
    ).run(
      nowIso(),
      input.summary ?? null,
      input.usage_input_tokens ?? 0,
      input.usage_output_tokens ?? 0,
      id,
    );
    return requireRun(id);
  }

  function failCurationRun(id: string, input: FailCurationRunInput): CurationRun {
    db.prepare(
      `UPDATE memory_curation_runs SET status = 'failed', completed_at = ?, error = ?
       WHERE id = ? AND status NOT IN ('completed', 'failed')`,
    ).run(nowIso(), input.error, id);
    return requireRun(id);
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
  };
}
