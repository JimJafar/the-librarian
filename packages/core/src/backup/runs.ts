// Backup run health (automated-backups A3). Every scheduled or manual backup
// records a row in the SQLite-authoritative `backup_runs` table (mirrors
// `memory_curation_runs`): a `running` row at start, updated to `ok`/`error` at
// the end. The dashboard reads these to show the last successful backup and to
// alert on the most recent failure.

import { randomUUID } from "node:crypto";
import type { InternalLibrarianStore } from "../store/librarian-store.js";

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

type RunsStore = Pick<InternalLibrarianStore, "db">;

interface BackupRunRow {
  id: string;
  status: BackupRunStatus;
  trigger: BackupRunTrigger;
  target: string | null;
  bundle: string | null;
  bytes: number;
  synced: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToRun(row: BackupRunRow): BackupRun {
  return { ...row, synced: row.synced !== 0 };
}

/** Insert a `running` row and return its id. */
export function startBackupRun(store: RunsStore, trigger: BackupRunTrigger): string {
  const id = `bkp_${randomUUID()}`;
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO backup_runs (id, status, trigger, bytes, synced, created_at, started_at)
       VALUES (?, 'running', ?, 0, 0, ?, ?)`,
    )
    .run(id, trigger, now, now);
  return id;
}

/** Update a run to its terminal `ok`/`error` state. */
export function finishBackupRun(store: RunsStore, id: string, result: FinishBackupRun): void {
  store.db
    .prepare(
      `UPDATE backup_runs
         SET status = ?, target = ?, bundle = ?, bytes = ?, synced = ?, error = ?, completed_at = ?
       WHERE id = ?`,
    )
    .run(
      result.status,
      result.target ?? null,
      result.bundle ?? null,
      result.bytes ?? 0,
      result.synced ? 1 : 0,
      result.error ?? null,
      new Date().toISOString(),
      id,
    );
}

/** Most-recent runs first, capped at `limit` (default 10). */
export function listBackupRuns(store: RunsStore, limit = 10): BackupRun[] {
  const rows = store.db
    .prepare(`SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as BackupRunRow[];
  return rows.map(rowToRun);
}

// A backup running longer than this was almost certainly killed mid-run (process
// crash / container restart). The scheduler is serial, so the only other in-flight
// run is a manual "Backup now", which completes in seconds/minutes — well under
// this — so a `running` row older than the TTL is safe to reclaim.
const STALE_RUN_TTL_MS = 60 * 60_000;

/**
 * Reconcile any run left `running` past the stale TTL (a crash between
 * start/finish) to `error`, so it stops showing as a phantom in-flight run and the
 * dashboard's failure surface is accurate. `completed_at` is set to the run's own
 * `created_at` so the scheduler's interval gate measures from the crash, not now.
 */
export function reconcileStaleBackupRuns(store: RunsStore): void {
  const cutoff = new Date(Date.now() - STALE_RUN_TTL_MS).toISOString();
  store.db
    .prepare(
      `UPDATE backup_runs
         SET status = 'error', error = 'stale_run_reclaimed', completed_at = created_at
       WHERE status = 'running' AND created_at < ?`,
    )
    .run(cutoff);
}

/** The most recent terminal (ok/error) run — what the scheduler gates the cadence on. */
export function latestTerminalBackupRun(store: RunsStore): BackupRun | null {
  const row = store.db
    .prepare(
      `SELECT * FROM backup_runs WHERE status IN ('ok', 'error') ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as unknown as BackupRunRow | undefined;
  return row ? rowToRun(row) : null;
}

/** The most recent successful run, or null. */
export function lastSuccessfulBackupRun(store: RunsStore): BackupRun | null {
  const row = store.db
    .prepare(`SELECT * FROM backup_runs WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1`)
    .get() as unknown as BackupRunRow | undefined;
  return row ? rowToRun(row) : null;
}
