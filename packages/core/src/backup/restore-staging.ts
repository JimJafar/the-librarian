// Restart-staged restore (automated-backups A5). The dashboard can't swap
// `librarian.sqlite` under a live DB connection, so a restore is split in two:
//
//   stageRestore()       — runs in the live server (tRPC): resolve the bundle
//                          (local, else pull from the cloud target), VALIDATE it
//                          without applying, and drop a `restore.pending.json`
//                          marker in the data dir. Refuses a corrupt bundle.
//   applyPendingRestore() — runs at BOOT, before the store opens (no live
//                          connection): swap the validated bundle into the data
//                          dir, then clear the marker. On failure the live data is
//                          untouched (restoreBackup validates before writing) and
//                          the marker is kept for the operator.

import fs from "node:fs";
import path from "node:path";
import type { LibrarianStore } from "../store/librarian-store.js";
import { restoreBackup, validateBundle } from "./restore.js";
import { fetchBundle } from "./sync/bundle.js";
import { resolveCloudTarget } from "./target.js";

export const RESTORE_MARKER = "restore.pending.json";
export const RESTORE_FAILED_MARKER = "restore.failed.json";
const STAGING_SUBDIR = "restore-staging";

export interface StageRestoreResult {
  staged: string;
  restartRequired: true;
}

export interface ApplyRestoreResult {
  applied: boolean;
  bundle?: string;
  error?: string;
}

interface RestoreMarker {
  bundle: string;
  dir: string;
  staged_from_cloud: boolean;
  staged_at: string;
  schema_version: number;
}

export async function stageRestore(
  store: LibrarianStore,
  options: { bundleName: string; backupDir: string },
): Promise<StageRestoreResult> {
  const { bundleName, backupDir } = options;
  // A bundle name is a plain basename (it becomes a path segment below).
  if (
    !bundleName ||
    bundleName.includes("/") ||
    bundleName.includes("\\") ||
    bundleName.includes("\0") ||
    bundleName.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`invalid bundle name: ${JSON.stringify(bundleName)}`);
  }

  // Prefer a local bundle; otherwise pull it from the configured cloud target.
  const localDir = path.join(backupDir, bundleName);
  let bundleDir: string;
  let stagedFromCloud = false;
  if (fs.existsSync(path.join(localDir, "manifest.json"))) {
    bundleDir = localDir;
  } else {
    const resolved = await resolveCloudTarget(store);
    if (!resolved) {
      throw new Error(
        `backup ${bundleName} is not present locally and no cloud target is configured to pull it from`,
      );
    }
    const stagingRoot = path.join(store.dataDir, STAGING_SUBDIR);
    fs.rmSync(path.join(stagingRoot, bundleName), { recursive: true, force: true });
    bundleDir = await fetchBundle(resolved.target, bundleName, stagingRoot);
    stagedFromCloud = true;
  }

  // Refuse to stage a corrupt bundle — validate fully without applying.
  const manifest = validateBundle(bundleDir);

  const marker: RestoreMarker = {
    bundle: bundleName,
    dir: bundleDir,
    staged_from_cloud: stagedFromCloud,
    staged_at: new Date().toISOString(),
    schema_version: manifest.schema_version,
  };
  fs.writeFileSync(
    path.join(store.dataDir, RESTORE_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return { staged: bundleName, restartRequired: true };
}

export function applyPendingRestore(dataDir: string): ApplyRestoreResult {
  const markerPath = path.join(dataDir, RESTORE_MARKER);
  if (!fs.existsSync(markerPath)) return { applied: false };

  let marker: RestoreMarker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as RestoreMarker;
  } catch (err) {
    return { applied: false, error: `unreadable ${RESTORE_MARKER}: ${(err as Error).message}` };
  }

  try {
    restoreBackup(marker.dir, { dataDir });
  } catch (err) {
    // Live data is untouched (restoreBackup validates before writing). Quarantine
    // the marker as `restore.failed.json` — kept for the operator (with the error),
    // but NOT retried on every boot. They can inspect it and re-stage.
    const error = (err as Error).message;
    try {
      fs.writeFileSync(
        path.join(dataDir, RESTORE_FAILED_MARKER),
        `${JSON.stringify({ ...marker, error, failed_at: new Date().toISOString() }, null, 2)}\n`,
      );
      fs.rmSync(markerPath, { force: true });
    } catch {
      // couldn't quarantine — leave the pending marker for a retry rather than lose it
    }
    return { applied: false, bundle: marker.bundle, error };
  }

  // Success: clear the marker and sweep the cloud-staging area (orphaned dirs from
  // earlier re-stages, plus this bundle's).
  fs.rmSync(markerPath, { force: true });
  fs.rmSync(path.join(dataDir, STAGING_SUBDIR), { recursive: true, force: true });
  return { applied: true, bundle: marker.bundle };
}
