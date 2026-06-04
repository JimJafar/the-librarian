// Orchestrate a backup: `git push` the vault to the configured remote, recording
// run health (automated-backups A3) and, on failure, firing the optional alert
// webhook. Async, so it runs from the server scheduler + the admin tRPC surface.
//
// The vault is the canonical store on the markdown backend, and it is already a
// git repo (commit-per-write), so a backup is just a push of HEAD — no bundle, no
// VACUUM, no cloud-object upload. Restore is a `git clone` of the repo (runbook).

import type { InternalLibrarianStore } from "../store/librarian-store.js";
import { type BackupConfig, readBackupConfig, resolveBackupRemote } from "./config.js";
import {
  type BackupRunTrigger,
  finishBackupRun,
  latestTerminalBackupRun,
  reconcileStaleBackupRuns,
  startBackupRun,
} from "./runs.js";

export interface RunBackupResult {
  /** Whether the vault was pushed (always true on success; failures throw). */
  pushed: boolean;
  /** The pushed commit hash (null only on an empty vault). */
  commit: string | null;
  /** "owner/repo" the vault was pushed to. */
  repo: string;
}

// Best-effort failure alert. Generic JSON, failure-only, no secrets (the backup
// error message is already token-scrubbed). A webhook failure must never mask — or
// be masked by — the backup failure, so it is fully swallowed.
async function fireFailureWebhook(config: BackupConfig, error: string): Promise<void> {
  if (!config.webhookUrl) return;
  try {
    await fetch(config.webhookUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "backup.failed", at: new Date().toISOString(), error }),
    });
  } catch {
    // best-effort
  }
}

// Serialize every backup run in this process. The scheduler tick and a manual
// "Backup now" both call runBackup; serializing them ensures two pushes never race
// on the same repo. A FIFO promise chain.
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
  options: { trigger?: BackupRunTrigger } = {},
): Promise<RunBackupResult> {
  return runExclusive(() => runBackupOnce(store, options));
}

async function runBackupOnce(
  store: InternalLibrarianStore,
  options: { trigger?: BackupRunTrigger },
): Promise<RunBackupResult> {
  const config = readBackupConfig(store);
  const remote = resolveBackupRemote(store);
  const runId = startBackupRun(store, options.trigger ?? "scheduled");
  try {
    if (!remote) {
      throw new Error(
        "no backup remote configured — set the GitHub repo + token in the backup settings",
      );
    }
    const commit = store.pushVaultBackup(remote.auth);
    finishBackupRun(store, runId, {
      status: "ok",
      target: remote.repo,
      bundle: commit,
      synced: true,
    });
    return { pushed: true, commit, repo: remote.repo };
  } catch (err) {
    // Push errors are already token-scrubbed at the push site; other errors
    // (e.g. "no remote configured") carry no token.
    const message = err instanceof Error ? err.message : String(err);
    finishBackupRun(store, runId, { status: "error", error: message });
    await fireFailureWebhook(config, message);
    throw err;
  }
}

// Scheduler tick: self-gates on the stored config (disabled → cheap no-op) and only
// runs when `intervalMinutes` has elapsed since the last COMPLETED run — so a
// long-running backup doesn't shrink the next interval, and a failed run backs off
// to the cadence instead of hammering. First reconciles any run left `running` by a
// crash. Mirrors the curator tick — safe to always start.
export async function runBackupTick(
  store: InternalLibrarianStore,
): Promise<RunBackupResult | null> {
  const config = readBackupConfig(store);
  if (!config.enabled) return null;

  reconcileStaleBackupRuns(store);

  const last = latestTerminalBackupRun(store);
  if (last?.completed_at) {
    const elapsedMinutes = (Date.now() - new Date(last.completed_at).getTime()) / 60_000;
    if (elapsedMinutes < config.intervalMinutes) return null;
  }
  return runBackup(store, { trigger: "scheduled" });
}
