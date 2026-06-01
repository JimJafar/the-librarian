// Orchestrate a backup: create the local bundle, then (if a cloud target is
// configured) upload it — recording run health (automated-backups A3) and, on
// failure, firing the optional alert webhook. Async, so it runs from the server
// scheduler + the admin tRPC surface (not the synchronous CLI). Sync failures do
// not lose the local backup — the bundle is already on disk before the upload.

import path from "node:path";
import type { InternalLibrarianStore } from "../store/librarian-store.js";
import { type BackupManifest, createBackup } from "./backup.js";
import { type BackupConfig, readBackupConfig } from "./config.js";
import { pruneLocal, pruneTarget } from "./retention.js";
import {
  type BackupRunTrigger,
  finishBackupRun,
  latestTerminalBackupRun,
  reconcileStaleBackupRuns,
  startBackupRun,
} from "./runs.js";
import { syncBundle } from "./sync/bundle.js";
import { type BackupTargetKind, type ResolvedTarget, resolveCloudTarget } from "./target.js";

export type { BackupTargetKind };

export interface RunBackupResult {
  dir: string;
  manifest: BackupManifest;
  synced: boolean;
  /** Which cloud target the bundle was synced to (omitted when not synced). */
  target?: BackupTargetKind;
  syncedKeys?: string[];
  /** Bundle names pruned by retention (local + cloud), newest-`keep` kept. */
  pruned?: string[];
  /** A best-effort prune failure message (the backup itself still succeeded). */
  pruneError?: string;
}

// Best-effort failure alert. Generic JSON, failure-only, no secrets (backup error
// messages are already token-scrubbed). A webhook failure must never mask — or be
// masked by — the backup failure, so it is fully swallowed.
async function fireFailureWebhook(config: BackupConfig, error: string): Promise<void> {
  if (!config.webhookUrl) return;
  try {
    await fetch(config.webhookUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "backup.failed",
        at: new Date().toISOString(),
        target: config.target,
        error,
      }),
    });
  } catch {
    // best-effort
  }
}

// Serialize every backup run in this process. The scheduler tick and a manual
// "Backup now" both call runBackup; serializing them ensures a prune in one never
// races a write/upload in the other (which could delete a bundle mid-flight), and
// closes the pre-existing two-runs-at-once double-write. A FIFO promise chain.
let backupQueue: Promise<unknown> = Promise.resolve();
function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = backupQueue.then(task, task);
  backupQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function runBackup(
  store: InternalLibrarianStore,
  options: { destDir: string; sync?: boolean; trigger?: BackupRunTrigger },
): Promise<RunBackupResult> {
  return runExclusive(() => runBackupOnce(store, options));
}

async function runBackupOnce(
  store: InternalLibrarianStore,
  options: { destDir: string; sync?: boolean; trigger?: BackupRunTrigger },
): Promise<RunBackupResult> {
  const config = readBackupConfig(store);
  const runId = startBackupRun(store, options.trigger ?? "scheduled");
  try {
    const { dir, manifest } = createBackup(store, { destDir: options.destDir });
    const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    const bundle = path.basename(dir);

    const result: RunBackupResult = { dir, manifest, synced: false };
    let resolved: ResolvedTarget | null = null;
    if (options.sync !== false) {
      resolved = await resolveCloudTarget(store, config);
      if (resolved) {
        result.syncedKeys = await syncBundle(resolved.target, dir);
        result.synced = true;
        result.target = resolved.kind;
      }
    }

    // Retention: keep the newest N bundles, prune the rest. Best-effort — the
    // backup already succeeded, so a prune failure must NOT fail the run (it
    // retries next time); it's surfaced via `pruneError`, never swallowed silently.
    try {
      // Assign local prunes first so they're still reported if the cloud prune
      // throws — a real deletion must never go unrecorded.
      result.pruned = pruneLocal(options.destDir, config.retentionKeep);
      if (resolved) {
        result.pruned = [
          ...result.pruned,
          ...(await pruneTarget(resolved.target, config.retentionKeep)),
        ];
      }
    } catch (err) {
      result.pruneError = err instanceof Error ? err.message : String(err);
    }

    finishBackupRun(store, runId, {
      status: "ok",
      target: result.target ?? "local",
      bundle,
      bytes,
      synced: result.synced,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishBackupRun(store, runId, { status: "error", error: message });
    await fireFailureWebhook(config, message);
    throw err;
  }
}

// Scheduler tick: self-gates on the stored config (disabled → cheap no-op) and
// only runs when `intervalMinutes` has elapsed since the last COMPLETED run — so a
// long-running backup doesn't shrink the next interval, and a failed run backs off
// to the cadence instead of hammering. First reconciles any run left `running` by a
// crash. Mirrors the curator tick — safe to always start.
export async function runBackupTick(
  store: InternalLibrarianStore,
  options: { destDir: string },
): Promise<RunBackupResult | null> {
  const config = readBackupConfig(store);
  if (!config.enabled) return null;

  reconcileStaleBackupRuns(store);

  const last = latestTerminalBackupRun(store);
  if (last?.completed_at) {
    const elapsedMinutes = (Date.now() - new Date(last.completed_at).getTime()) / 60_000;
    if (elapsedMinutes < config.intervalMinutes) return null;
  }
  return runBackup(store, { destDir: options.destDir, trigger: "scheduled" });
}
