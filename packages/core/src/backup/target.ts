// Resolve the configured cloud backup target (automated-backups A3/A5). Shared by
// runBackup (to sync a fresh bundle) and restore-staging (to pull a bundle that may
// only exist in the cloud). 'local' → no target; a selected target whose
// credentials are missing also resolves to null.

import type { LibrarianStore } from "../store/librarian-store.js";
import { type BackupConfig, readBackupConfig } from "./config.js";
import { resolveS3SyncConfig } from "./sync/config.js";
import { resolveGithubSyncConfig } from "./sync/github-config.js";
import { createGithubTarget } from "./sync/github.js";
import { createS3Target } from "./sync/s3.js";
import type { BackupTarget } from "./sync/types.js";

export type BackupTargetKind = "s3" | "github";

export interface ResolvedTarget {
  kind: BackupTargetKind;
  target: BackupTarget;
}

export async function resolveCloudTarget(
  store: LibrarianStore,
  config: BackupConfig = readBackupConfig(store),
): Promise<ResolvedTarget | null> {
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
