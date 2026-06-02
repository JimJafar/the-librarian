// Curator due-slice selection (sessions-rethink spec §12.4). Composes
// candidate-slice enumeration with the last-completed-run lookup into the set
// of slices that should run now under the interval gate. Read-only; the
// server-side scheduler wraps this with a timer + slice locking, and runs
// each due slice via runCuration as the system-memory-curator actor.

import type { DatabaseSync } from "node:sqlite";
import type { CuratorMemorySource, EvidenceSlice } from "./curator-evidence.js";
import { type DueReason, type ScheduleConfig, isSliceDue } from "./curator-schedule.js";

export interface DueSlice {
  slice: EvidenceSlice;
  reason: DueReason;
  lastCompletedAt: Date | null;
}

// Slices come from the memory source (vault or SQLite projection); run history
// (last-completed / running) still reads the SQLite-authoritative
// `memory_curation_runs` via `db`. The run-read side moves off SQLite with the
// run store at the Phase-4 SQLite removal — until then, this composes the two.
export function selectDueSlices(
  memorySource: CuratorMemorySource,
  db: DatabaseSync,
  config: ScheduleConfig,
  now: Date,
): DueSlice[] {
  const due: DueSlice[] = [];
  for (const slice of memorySource.listSlices()) {
    const lastCompletedAt = lastCompletedRunAt(db, slice);
    const decision = isSliceDue(now, { lastCompletedAt }, config);
    if (decision.due) due.push({ slice, reason: decision.reason, lastCompletedAt });
  }
  return due;
}

interface Filter {
  clause: string;
  params: string[];
}

// Slice → run-row filter (runs key the owning agent on agent_id).
function runFilter(slice: EvidenceSlice): Filter {
  switch (slice.kind) {
    case "common_global":
      return { clause: "visibility = 'common' AND project_key IS NULL", params: [] };
    case "common_project":
      return {
        clause: "visibility = 'common' AND project_key = ?",
        params: [slice.projectKey ?? ""],
      };
    case "agent_private":
      return {
        clause: "visibility = 'agent_private' AND agent_id = ?",
        params: [slice.agentId ?? ""],
      };
  }
}

/**
 * The latest in-progress (running) run for a slice — the §10.1 lock. A non-null
 * result means the slice is being worked; the caller compares startedAt against a
 * TTL to distinguish an active lock from a stale (crashed-worker) one to reclaim.
 */
export function findRunningRun(
  db: DatabaseSync,
  slice: EvidenceSlice,
): { id: string; startedAt: Date } | null {
  const { clause, params } = runFilter(slice);
  const row = db
    .prepare(
      `SELECT id, started_at FROM memory_curation_runs
       WHERE ${clause} AND status = 'running' AND started_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(...params) as { id: string; started_at: string } | undefined;
  return row ? { id: row.id, startedAt: new Date(row.started_at) } : null;
}

function lastCompletedRunAt(db: DatabaseSync, slice: EvidenceSlice): Date | null {
  const { clause, params } = runFilter(slice);
  const row = db
    .prepare(
      `SELECT completed_at FROM memory_curation_runs
       WHERE ${clause} AND status = 'completed' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
    )
    .get(...params) as { completed_at: string } | undefined;
  return row?.completed_at ? new Date(row.completed_at) : null;
}
