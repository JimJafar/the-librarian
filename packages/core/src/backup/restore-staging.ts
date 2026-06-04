// Restart-staged restore (git-native). The dashboard can't swap the vault under a
// live store (the open git repo + in-memory index), so a restore is two phases:
//
//   stageRestore()        — runs in the live server (tRPC): clone the backup remote
//                           into a staging dir, validate it, and drop a
//                           `restore.pending.json` marker. Live data is untouched.
//   applyPendingRestore() — runs at BOOT, before the store opens: back up the live
//                           vault to `vault.pre-restore.bak` (reversible), swap the
//                           clone in, clear the marker. On failure the live vault is
//                           put back and the marker is quarantined (not retried).

import fs from "node:fs";
import path from "node:path";
import { cloneVaultBackup } from "../store/git/index.js";
import type { LibrarianStore } from "../store/librarian-store.js";
import { resolveBackupRemote } from "./config.js";

export const RESTORE_MARKER = "restore.pending.json";
export const RESTORE_FAILED_MARKER = "restore.failed.json";
const STAGING_SUBDIR = "restore-staging";
const STAGED_VAULT = "vault";
const VAULT_DIR = "vault";
/** The live vault is moved here before a restore swaps the backup in — reversible. */
export const PRE_RESTORE_BAK = "vault.pre-restore.bak";

export interface StageRestoreResult {
  /** The "owner/repo" the restore was staged from. */
  staged: string;
  restartRequired: true;
}

export interface ApplyRestoreResult {
  applied: boolean;
  repo?: string;
  error?: string;
}

interface RestoreMarker {
  repo: string;
  staged_at: string;
}

/** Validate that `dir` is a cloned vault (a git repo on disk). */
function isClonedVault(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

export function stageRestore(store: LibrarianStore): StageRestoreResult {
  const remote = resolveBackupRemote(store);
  if (!remote) {
    throw new Error(
      "restore: no backup remote configured — set the GitHub repo + token in the backup settings",
    );
  }

  const stagingRoot = path.join(store.dataDir, STAGING_SUBDIR);
  fs.rmSync(stagingRoot, { recursive: true, force: true }); // clear any prior staging
  const stagedVault = path.join(stagingRoot, STAGED_VAULT);

  cloneVaultBackup({
    remoteUrl: remote.auth.remoteUrl,
    branch: remote.auth.branch,
    token: remote.auth.token,
    dest: stagedVault,
  });

  // Refuse to stage a clone that doesn't look like a vault — better to fail here
  // (live data untouched) than at boot.
  if (!isClonedVault(stagedVault)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new Error("restore: the cloned backup is not a git repository");
  }

  const marker: RestoreMarker = { repo: remote.repo, staged_at: new Date().toISOString() };
  fs.writeFileSync(
    path.join(store.dataDir, RESTORE_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return { staged: remote.repo, restartRequired: true };
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

  const stagedVault = path.join(dataDir, STAGING_SUBDIR, STAGED_VAULT);
  const liveVault = path.join(dataDir, VAULT_DIR);
  const bak = path.join(dataDir, PRE_RESTORE_BAK);

  try {
    if (!isClonedVault(stagedVault)) {
      throw new Error("the staged restore is missing or not a git repository");
    }

    // Back up the live vault (reversible), then swap the clone in. Same-dir renames
    // are atomic; if the swap fails after the backup, put the live vault back so a
    // failed restore never loses data.
    fs.rmSync(bak, { recursive: true, force: true }); // drop any prior pre-restore backup
    const hadLive = fs.existsSync(liveVault);
    if (hadLive) fs.renameSync(liveVault, bak);
    try {
      fs.renameSync(stagedVault, liveVault);
    } catch (swapErr) {
      if (hadLive) fs.renameSync(bak, liveVault); // recover the live vault
      throw swapErr;
    }

    fs.rmSync(path.join(dataDir, STAGING_SUBDIR), { recursive: true, force: true });
    fs.rmSync(markerPath, { force: true });
    return { applied: true, repo: marker.repo };
  } catch (err) {
    // Live data is untouched (or recovered). Quarantine the marker as
    // `restore.failed.json` — kept for the operator, NOT retried on every boot.
    const error = (err as Error).message;
    try {
      fs.writeFileSync(
        path.join(dataDir, RESTORE_FAILED_MARKER),
        `${JSON.stringify({ ...marker, error, failed_at: new Date().toISOString() }, null, 2)}\n`,
      );
      fs.rmSync(markerPath, { force: true });
    } catch {
      // couldn't quarantine — leave the pending marker rather than lose it
    }
    return { applied: false, repo: marker.repo, error };
  }
}
