// Restart-staged restore (git-native). The dashboard can't swap the vault under a
// live store (the open git repo + in-memory index), so a restore is two phases:
//
//   stageRestore()        — runs in the live server (tRPC): clone the backup remote
//                           into a staging dir beside the vault, validate it, and
//                           drop a `restore.pending.json` marker. Live data is
//                           untouched.
//   applyPendingRestore() — runs at BOOT, before the store opens: back up the live
//                           vault to `<vault>.pre-restore.bak` (reversible), swap
//                           the clone in, clear the marker. On failure the live
//                           vault is put back and the marker is quarantined.

import fs from "node:fs";
import path from "node:path";
import { resolveVaultPath } from "../store/corpus/index.js";
import { cloneVaultBackup } from "../store/git/index.js";
import type { LibrarianStore } from "../store/librarian-store.js";
import { resolveBackupRemote } from "./config.js";

export const RESTORE_MARKER = "restore.pending.json";
export const RESTORE_FAILED_MARKER = "restore.failed.json";
const PRE_RESTORE_SUFFIX = ".pre-restore.bak";
const STAGING_NAME = ".restore-staging";
/** Default-layout pre-restore backup name (display + the default-path tests). */
export const PRE_RESTORE_BAK = `vault${PRE_RESTORE_SUFFIX}`;

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

interface RestorePaths {
  liveVault: string;
  stagedVault: string;
  bak: string;
  markerPath: string;
  failedMarkerPath: string;
}

// Resolve the live vault the SAME way the store does (honors LIBRARIAN_VAULT_PATH),
// and keep the staging clone + the pre-restore backup as siblings of it — so the
// swap is always a same-filesystem rename and never silently targets the wrong dir.
// The marker lives in the data dir, where the boot path looks for it.
function restorePaths(dataDir: string): RestorePaths {
  const liveVault = resolveVaultPath({ dataDir });
  const parent = path.dirname(liveVault);
  return {
    liveVault,
    stagedVault: path.join(parent, STAGING_NAME),
    bak: `${liveVault}${PRE_RESTORE_SUFFIX}`,
    markerPath: path.join(dataDir, RESTORE_MARKER),
    failedMarkerPath: path.join(dataDir, RESTORE_FAILED_MARKER),
  };
}

// A restored vault must look like a Librarian vault — a git repo containing at
// least one known vault directory — so a wrong/arbitrary repo configured as the
// backup remote can't silently replace it. (A never-committed repo fails the clone
// before we ever get here.)
//
// The canonical layout can live at the vault ROOT (the OSS single-shelf vault) OR
// beneath a SHELF PREFIX (spec 062 / ADR 0011 Decision 5: a Teams vault routes
// principals to prefixes like `team/` and `members/x/`, each carrying the canonical
// layout beneath it — `team/memories/`, `members/x/memories/`, …). A shelf-prefixed
// vault has NO canonical dir at the root, so the pre-062 root-only check rejected
// exactly the tree a Teams-shape backup/restore round-trip produces (spec 062 SC 9).
//
// So the accepted shapes are: a canonical dir (`memories`/`inbox`/`references`/
// `handoffs`) directly at the vault root, OR one nested beneath a shelf prefix of up
// to two segments — the shelf-prefix shapes spec 062 names (`team/` at one level,
// `members/x/` at two). That bound is deliberate: this is a "does this look like a
// vault AT ALL?" guard against restoring a NON-vault, not a full structural
// validation, so it stops at the FIRST canonical dir it finds and never walks the
// whole tree. `.git` is never a shelf prefix, so it is skipped on descent.
const VAULT_DIRS = ["memories", "inbox", "references", "handoffs"];
/** Max shelf-prefix nesting we descend looking for the canonical layout (spec 062's prefix
 * shapes are one or two segments: `team/`, `members/x/`). */
const MAX_SHELF_PREFIX_DEPTH = 2;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// True if a canonical vault dir sits directly in `dir`, or beneath a subdirectory of `dir`
// within `depth` further levels (a shelf prefix). Short-circuits on the first hit.
function hasCanonicalLayout(dir: string, depth: number): boolean {
  if (VAULT_DIRS.some((name) => isDir(path.join(dir, name)))) return true;
  if (depth <= 0) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue; // .git is never a shelf prefix
    if (hasCanonicalLayout(path.join(dir, entry.name), depth - 1)) return true;
  }
  return false;
}

function isLibrarianVault(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  return hasCanonicalLayout(dir, MAX_SHELF_PREFIX_DEPTH);
}

export function stageRestore(store: LibrarianStore): StageRestoreResult {
  const remote = resolveBackupRemote(store);
  if (!remote) {
    throw new Error(
      "restore: no backup remote configured — set the GitHub repo + token in the backup settings",
    );
  }

  const { stagedVault, markerPath } = restorePaths(store.dataDir);
  fs.rmSync(stagedVault, { recursive: true, force: true }); // clear any prior staging

  cloneVaultBackup({
    remoteUrl: remote.auth.remoteUrl,
    branch: remote.auth.branch,
    token: remote.auth.token,
    dest: stagedVault,
  });

  // Refuse to stage a clone that doesn't look like a vault — better to fail here
  // (live data untouched) than swap junk in at boot.
  if (!isLibrarianVault(stagedVault)) {
    fs.rmSync(stagedVault, { recursive: true, force: true });
    throw new Error(
      "restore: the cloned repo does not look like a Librarian vault " +
        "(no memories/inbox/references/handoffs) — check the configured backup repo",
    );
  }

  const marker: RestoreMarker = { repo: remote.repo, staged_at: new Date().toISOString() };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return { staged: remote.repo, restartRequired: true };
}

export function applyPendingRestore(dataDir: string): ApplyRestoreResult {
  const { liveVault, stagedVault, bak, markerPath, failedMarkerPath } = restorePaths(dataDir);
  if (!fs.existsSync(markerPath)) return { applied: false };

  // Quarantine the marker so a bad restore neither retries on every boot nor is
  // silently lost. If quarantining itself fails, leave the pending marker.
  const quarantine = (marker: RestoreMarker | null, error: string): ApplyRestoreResult => {
    try {
      fs.writeFileSync(
        failedMarkerPath,
        `${JSON.stringify({ ...(marker ?? {}), error, failed_at: new Date().toISOString() }, null, 2)}\n`,
      );
      fs.rmSync(markerPath, { force: true });
    } catch {
      /* couldn't quarantine — keep the pending marker rather than lose it */
    }
    return { applied: false, ...(marker?.repo ? { repo: marker.repo } : {}), error };
  };

  let marker: RestoreMarker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as RestoreMarker;
  } catch (err) {
    return quarantine(null, `unreadable ${RESTORE_MARKER}: ${(err as Error).message}`);
  }

  try {
    if (!isLibrarianVault(stagedVault)) {
      throw new Error("the staged restore is missing or does not look like a Librarian vault");
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

    fs.rmSync(stagedVault, { recursive: true, force: true });
    fs.rmSync(markerPath, { force: true });
    return { applied: true, repo: marker.repo };
  } catch (err) {
    // Live vault is untouched (or recovered); its prior content is in `bak`.
    return quarantine(marker, (err as Error).message);
  }
}
