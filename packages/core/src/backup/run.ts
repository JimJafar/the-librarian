// Orchestrate a backup: create the local bundle, then (if cloud sync is
// configured) upload it. Async, so it runs from the server scheduler + the admin
// tRPC surface (not the synchronous CLI). Sync failures do not lose the local
// backup — the bundle is already on disk before the upload is attempted.

import type { LibrarianStore } from "../store/librarian-store.js";
import { type BackupManifest, createBackup } from "./backup.js";
import { syncBundle } from "./sync/bundle.js";
import { resolveS3SyncConfig } from "./sync/config.js";
import { createS3Target } from "./sync/s3.js";

export interface RunBackupResult {
  dir: string;
  manifest: BackupManifest;
  synced: boolean;
  syncedKeys?: string[];
}

export async function runBackup(
  store: LibrarianStore,
  options: { destDir: string; sync?: boolean },
): Promise<RunBackupResult> {
  const { dir, manifest } = createBackup(store, { destDir: options.destDir });

  if (options.sync === false) return { dir, manifest, synced: false };
  const config = resolveS3SyncConfig(store);
  if (!config) return { dir, manifest, synced: false };

  const target = await createS3Target(config);
  const syncedKeys = await syncBundle(target, dir);
  return { dir, manifest, synced: true, syncedKeys };
}
