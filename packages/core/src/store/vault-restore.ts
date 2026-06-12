// Whole-vault restore + activity-feed provenance (rethink T21, spec §8 / D16).
//
// The guarded restore sequence, exactly as D16 orders it (the tRPC layer owns
// the typed-confirmation gate before any of this runs):
//
//   1. refuse while a curation/intake run is in flight, and while another
//      restore holds the (process-wide) restore lock;
//   2. pause the curator — both ticks check `isCuratorPausedForRestore`
//      before anything else, run-now included;
//   3. snapshot any uncommitted out-of-band edits, then `git tag
//      pre-restore-<timestamp>` on the current HEAD (the safety anchor);
//   4. make the working tree match the target commit's tree and commit it as
//      ONE new commit ("vault: restore to <hash>") — never a history rewrite;
//   5. invalidate the disposable index/caches; resume the curator.
//
// Resume is in a `finally`: a failure anywhere mid-sequence still resumes the
// curator, and the thrown error says honestly how far the sequence got (the
// safety tag, once created, is named so the operator can find it).

import {
  isCuratorPausedForRestore,
  pauseCuratorForRestore,
  resumeCuratorAfterRestore,
} from "../curator-pause.js";
import type { GitHistory } from "./git/git-history.js";
import type { SettingsStore } from "./settings-store.js";

/** A second restore (or one from another admin tab) while one is running. */
export class VaultRestoreInProgressError extends Error {}

/** A curator run is mid-flight — restoring under it would corrupt its writes. */
export class CurationRunInFlightError extends Error {}

/** The target hash names no commit in the vault's history. */
export class VaultRestoreUnknownCommitError extends Error {}

/** A mid-sequence failure, reported with how far the sequence got. */
export class VaultRestoreError extends Error {}

export interface VaultRestoreResult {
  /** The commit the vault tree now matches. */
  restoredTo: string;
  /** The safety tag left on the pre-restore HEAD. */
  preRestoreTag: string;
  /**
   * The ONE new restore commit, or null when the target tree already matched
   * HEAD (nothing to commit — the vault was already in that state).
   */
  commit: string | null;
}

export interface VaultRestoreDeps {
  settings: SettingsStore;
  git: { head(): string | null; commitAll(message: string): string | null };
  history: GitHistory;
  /** Is any curation/intake run currently `running`? (checked before pausing) */
  hasRunningCurationRun(): boolean;
  /** Drop the disposable recall index + primer cache after the tree changed. */
  invalidate(): void;
}

export interface VaultRestoreOptions {
  now?: Date;
  /**
   * Test seam (rethink T21 e2e): awaited right after the curator is paused,
   * so a test can run a real tick mid-restore and assert it observes the
   * pause. Production never sets it.
   */
  onPausedForTest?: () => void | Promise<void>;
}

// One restore at a time, process-wide — the same process owns the schedulers
// and the tRPC surface, so this is the authoritative lock.
let restoreInFlight = false;

/** The safety tag name: filesystem/ref-safe UTC stamp, e.g. pre-restore-20260612-153000. */
export function preRestoreTagName(now: Date): string {
  return `pre-restore-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
}

export async function restoreVaultToCommit(
  deps: VaultRestoreDeps,
  hash: string,
  options: VaultRestoreOptions = {},
): Promise<VaultRestoreResult> {
  const now = options.now ?? new Date();
  if (restoreInFlight || isCuratorPausedForRestore(deps.settings, now)) {
    throw new VaultRestoreInProgressError(
      "a vault restore is already in progress — wait for it to finish before starting another",
    );
  }
  if (deps.hasRunningCurationRun()) {
    throw new CurationRunInFlightError(
      "a curator run is in flight — wait for it to finish (or check the Curator page), then retry the restore",
    );
  }
  if (!deps.history.commitExists(hash)) {
    throw new VaultRestoreUnknownCommitError(
      `no commit '${hash}' exists in the vault's history — pick one from the activity feed`,
    );
  }

  restoreInFlight = true;
  pauseCuratorForRestore(deps.settings, now);
  let tagName: string | null = null;
  try {
    await options.onPausedForTest?.();
    // Capture any uncommitted out-of-band edits first, so the safety tag (and
    // a later return to it) covers EVERYTHING that existed before the restore.
    deps.git.commitAll("vault: pre-restore snapshot");
    tagName = preRestoreTagName(now);
    deps.history.tag(tagName);
    // The whole tree back to the target's state, as ONE new commit.
    deps.history.restoreTreeTo(hash);
    const commit = deps.git.commitAll(`vault: restore to ${hash}`);
    deps.invalidate(); // the index rebuilds from markdown by construction
    return { restoredTo: hash, preRestoreTag: tagName, commit };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VaultRestoreError(
      tagName === null
        ? `vault restore to ${hash} failed before any change was made (the curator was resumed): ${detail}`
        : `vault restore to ${hash} failed mid-sequence after creating safety tag '${tagName}' — ` +
            `the working tree may be partially restored; inspect the vault (the tag marks the ` +
            `pre-restore state) before retrying. The curator was resumed. Cause: ${detail}`,
    );
  } finally {
    resumeCuratorAfterRestore(deps.settings);
    restoreInFlight = false;
  }
}

// ── activity-feed provenance (rethink T21) ────────────────────────────────────

/**
 * Who a vault commit came from, derived from the commit-subject conventions
 * (the vault has a single committer identity, so the subject prefix IS the
 * provenance channel):
 *
 *   agent    `inbox: submit …` (remember), `memory: flag …`,
 *            `handoff: store/claim …`
 *   curator  `inbox: consolidate sweep`, `curator: …` (addendum/rollback),
 *            and the memory lifecycle writes `memory: store/propose/update/
 *            archive/unarchive …` — the curator's apply path. CAVEAT: admin
 *            edits from the dashboard MEMORY BROWSER share this write path,
 *            so those land as `curator` too; subjects don't distinguish them.
 *   admin    `vault: …` (explorer/editor + restores), `primer: update`,
 *            `memory: approve/reject/purge/resolve-flags/bulk-update …`,
 *            `handoff: purge …` — admin-only surfaces.
 *   system   `backup: snapshot`, `vault: pre-restore snapshot`.
 *   other    anything else (e.g. hand-made commits from a checkout).
 */
export type VaultCommitSource = "agent" | "curator" | "admin" | "system" | "other";

export function classifyVaultCommit(subject: string): VaultCommitSource {
  if (subject === "backup: snapshot" || subject === "vault: pre-restore snapshot") return "system";
  if (subject === "inbox: consolidate sweep") return "curator";
  if (subject.startsWith("curator: ")) return "curator";
  if (subject.startsWith("inbox: submit ")) return "agent";
  if (subject.startsWith("memory: flag ")) return "agent";
  if (subject.startsWith("handoff: store ") || subject.startsWith("handoff: claim ")) {
    return "agent";
  }
  if (subject.startsWith("handoff: purge ")) return "admin";
  if (/^memory: (approve|reject|purge|resolve-flags|bulk-update) /.test(subject)) return "admin";
  if (/^memory: (store|propose|update|archive|unarchive) /.test(subject)) return "curator";
  if (subject.startsWith("vault: ") || subject === "primer: update") return "admin";
  return "other";
}
