// Orchestrate a backup: create the local bundle, then (if a cloud target is
// configured) upload it — recording run health (automated-backups A3) and, on
// failure, firing the optional alert webhook. Async, so it runs from the server
// scheduler + the admin tRPC surface (not the synchronous CLI). Sync failures do
// not lose the local backup — the bundle is already on disk before the upload.

import path from "node:path";
import type { LibrarianStore } from "../store/librarian-store.js";
import { type BackupManifest, createBackup } from "./backup.js";
import { type BackupConfig, readBackupConfig } from "./config.js";
import {
  type BackupRunTrigger,
  finishBackupRun,
  latestTerminalBackupRun,
  reconcileStaleBackupRuns,
  startBackupRun,
} from "./runs.js";
import { syncBundle } from "./sync/bundle.js";
import { resolveS3SyncConfig } from "./sync/config.js";
import { resolveGithubSyncConfig } from "./sync/github-config.js";
import { createGithubTarget } from "./sync/github.js";
import { createS3Target } from "./sync/s3.js";
import type { BackupTarget } from "./sync/types.js";

export type BackupTargetKind = "s3" | "github";

export interface RunBackupResult {
  dir: string;
  manifest: BackupManifest;
  synced: boolean;
  /** Which cloud target the bundle was synced to (omitted when not synced). */
  target?: BackupTargetKind;
  syncedKeys?: string[];
}

// Resolve the cloud target the config selects ('local' → no sync). A selected
// target whose credentials are missing resolves to null (the run records
// synced=false rather than failing).
async function resolveBackupTarget(
  store: LibrarianStore,
  config: BackupConfig,
): Promise<{ kind: BackupTargetKind; target: BackupTarget } | null> {
  if (config.target === "s3") {
    const s3 = resolveS3SyncConfig(store);
    return s3 ? { kind: "s3", target: await createS3Target(s3) } : null;
  }
  if (config.target === "github") {
    const github = resolveGithubSyncConfig(store);
    return github ? { kind: "github", target: createGithubTarget(github) } : null;
  }
  return null;
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

export async function runBackup(
  store: LibrarianStore,
  options: { destDir: string; sync?: boolean; trigger?: BackupRunTrigger },
): Promise<RunBackupResult> {
  const config = readBackupConfig(store);
  const runId = startBackupRun(store, options.trigger ?? "scheduled");
  try {
    const { dir, manifest } = createBackup(store, { destDir: options.destDir });
    const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    const bundle = path.basename(dir);

    const result: RunBackupResult = { dir, manifest, synced: false };
    if (options.sync !== false) {
      const resolved = await resolveBackupTarget(store, config);
      if (resolved) {
        result.syncedKeys = await syncBundle(resolved.target, dir);
        result.synced = true;
        result.target = resolved.kind;
      }
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
  store: LibrarianStore,
  options: { destDir: string },
): Promise<void> {
  const config = readBackupConfig(store);
  if (!config.enabled) return;

  reconcileStaleBackupRuns(store);

  const last = latestTerminalBackupRun(store);
  if (last?.completed_at) {
    const elapsedMinutes = (Date.now() - new Date(last.completed_at).getTime()) / 60_000;
    if (elapsedMinutes < config.intervalMinutes) return;
  }
  await runBackup(store, { destDir: options.destDir, trigger: "scheduled" });
}
