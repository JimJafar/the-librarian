// Backup run health (automated-backups A3). Every scheduled or manual backup
// records an entry in a sidecar `backup-runs.json` under the data dir (OUTSIDE
// the git vault — it is bookkeeping, not durable knowledge): a `running` entry
// at start, updated to `ok`/`error` at the end. The dashboard reads these to
// show the last successful backup and to alert on the most recent failure.
//
// Persisted as a plain JSON array (whole-file read/write per op — fine at the
// scale of a bounded run history). Moved off the SQLite `backup_runs` table at
// the Phase-7 SQLite cutover; the markdown backend has no event-ledger db.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type BackupRunStatus = "running" | "ok" | "error";
export type BackupRunTrigger = "scheduled" | "manual";

export interface BackupRun {
  id: string;
  status: BackupRunStatus;
  trigger: BackupRunTrigger;
  target: string | null;
  bundle: string | null;
  bytes: number;
  synced: boolean;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface FinishBackupRun {
  status: "ok" | "error";
  target?: string | null;
  bundle?: string | null;
  bytes?: number;
  synced?: boolean;
  error?: string | null;
}

/** Sidecar file name (under the data dir), outside the git vault. */
export const BACKUP_RUNS_FILE = "backup-runs.json";

// Keep the sidecar bounded — the dashboard only ever lists the most recent runs,
// and the whole file is rewritten per op. (The old SQLite `backup_runs` table was
// unbounded; a bounded JSON history is strictly kinder to the whole-file rewrite.)
const MAX_RUNS = 50;

/** The runs store needs only the data dir — it no longer touches the SQLite db. */
type RunsStore = { dataDir: string };

function runsPath(store: RunsStore): string {
  return path.join(store.dataDir, BACKUP_RUNS_FILE);
}

function readRuns(store: RunsStore): BackupRun[] {
  const file = runsPath(store);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as BackupRun[]) : [];
  } catch {
    return []; // corrupt/empty → start fresh (health records are best-effort)
  }
}

function writeRuns(store: RunsStore, runs: BackupRun[]): void {
  const file = runsPath(store);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Newest-first, bounded, then persisted atomically (temp + rename) so a crash
  // mid-write can never truncate the file to a half-record.
  const bounded = [...runs]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_RUNS);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(bounded, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function sortedRuns(store: RunsStore): BackupRun[] {
  return readRuns(store).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Insert a `running` entry and return its id. */
export function startBackupRun(store: RunsStore, trigger: BackupRunTrigger): string {
  const id = `bkp_${randomUUID()}`;
  const now = new Date().toISOString();
  const runs = readRuns(store);
  runs.push({
    id,
    status: "running",
    trigger,
    target: null,
    bundle: null,
    bytes: 0,
    synced: false,
    error: null,
    created_at: now,
    started_at: now,
    completed_at: null,
  });
  writeRuns(store, runs);
  return id;
}

/** Update a run to its terminal `ok`/`error` state. */
export function finishBackupRun(store: RunsStore, id: string, result: FinishBackupRun): void {
  const runs = readRuns(store);
  const run = runs.find((r) => r.id === id);
  if (!run) return; // the entry was pruned/reset out from under us — nothing to finish
  run.status = result.status;
  run.target = result.target ?? null;
  run.bundle = result.bundle ?? null;
  run.bytes = result.bytes ?? 0;
  run.synced = result.synced ?? false;
  run.error = result.error ?? null;
  run.completed_at = new Date().toISOString();
  writeRuns(store, runs);
}

/** Most-recent runs first, capped at `limit` (default 10). */
export function listBackupRuns(store: RunsStore, limit = 10): BackupRun[] {
  return sortedRuns(store).slice(0, limit);
}

// A backup running longer than this was almost certainly killed mid-run (process
// crash / container restart). The scheduler is serial, so the only other in-flight
// run is a manual "Backup now", which completes in seconds/minutes — well under
// this — so a `running` entry older than the TTL is safe to reclaim.
const STALE_RUN_TTL_MS = 60 * 60_000;

/**
 * Reconcile any run left `running` past the stale TTL (a crash between
 * start/finish) to `error`, so it stops showing as a phantom in-flight run and the
 * dashboard's failure surface is accurate. `completed_at` is set to the run's own
 * `created_at` so the scheduler's interval gate measures from the crash, not now.
 */
export function reconcileStaleBackupRuns(store: RunsStore): void {
  const cutoff = new Date(Date.now() - STALE_RUN_TTL_MS).toISOString();
  const runs = readRuns(store);
  let changed = false;
  for (const run of runs) {
    if (run.status === "running" && run.created_at < cutoff) {
      run.status = "error";
      run.error = "stale_run_reclaimed";
      run.completed_at = run.created_at;
      changed = true;
    }
  }
  if (changed) writeRuns(store, runs);
}

/** The most recent terminal (ok/error) run — what the scheduler gates the cadence on. */
export function latestTerminalBackupRun(store: RunsStore): BackupRun | null {
  return sortedRuns(store).find((r) => r.status === "ok" || r.status === "error") ?? null;
}

/** The most recent successful run, or null. */
export function lastSuccessfulBackupRun(store: RunsStore): BackupRun | null {
  return sortedRuns(store).find((r) => r.status === "ok") ?? null;
}
