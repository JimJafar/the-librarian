// Orchestrate a backup: create the local bundle, then (if cloud sync is
// configured) upload it. Async, so it runs from the server scheduler + the admin
// tRPC surface (not the synchronous CLI). Sync failures do not lose the local
// backup — the bundle is already on disk before the upload is attempted.

import type { LibrarianStore } from "../store/librarian-store.js";
import { type BackupManifest, createBackup } from "./backup.js";
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

// Resolve the single configured cloud target. S3 takes precedence over GitHub when
// both are configured (one cloud target per run — see spec non-goals).
async function resolveBackupTarget(
  store: LibrarianStore,
): Promise<{ kind: BackupTargetKind; target: BackupTarget } | null> {
  const s3 = resolveS3SyncConfig(store);
  if (s3) return { kind: "s3", target: await createS3Target(s3) };
  const github = resolveGithubSyncConfig(store);
  if (github) return { kind: "github", target: createGithubTarget(github) };
  return null;
}

export async function runBackup(
  store: LibrarianStore,
  options: { destDir: string; sync?: boolean },
): Promise<RunBackupResult> {
  const { dir, manifest } = createBackup(store, { destDir: options.destDir });

  if (options.sync === false) return { dir, manifest, synced: false };
  const resolved = await resolveBackupTarget(store);
  if (!resolved) return { dir, manifest, synced: false };

  const syncedKeys = await syncBundle(resolved.target, dir);
  return { dir, manifest, synced: true, target: resolved.kind, syncedKeys };
}
