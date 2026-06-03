// Synchronous git-ops for the markdown MemoryStore's commit-per-write path
// (spec 035 §F12). The store is sync (the storage-agnostic verb tests are
// sync), so it can't await the simple-git service (#220, which serves the
// async consolidator / dashboard / backup). This is the same contract,
// shelling out to `git` synchronously via child_process.
//
// A fallback commit identity is configured locally (only when none is set)
// so headless / CI commits never fail.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export interface SyncGitOps {
  /** Idempotently `git init` the repo + ensure a commit identity exists. */
  init(): void;
  /**
   * Stage everything (incl. deletions) and commit. Returns the new HEAD
   * hash, or `null` when there was nothing to commit (no empty commits).
   */
  commitAll(message: string): string | null;
  /** Current HEAD hash, or `null` on a repo with no commits yet. */
  head(): string | null;
  /** Commit subjects, newest first (empty on a repo with no commits). */
  log(): string[];
  isRepo(): boolean;
}

export function createSyncGitOps(opts: { cwd: string }): SyncGitOps {
  fs.mkdirSync(opts.cwd, { recursive: true });

  const git = (args: string[]): string =>
    // stderr piped (not inherited) so routine git noise — `init` branch
    // hints, the pre-init `rev-parse` "fatal: not a git repository" probe —
    // stays off the console; on failure it's still attached to the thrown
    // error's `.stderr`.
    execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const tryGit = (args: string[]): string | null => {
    try {
      return git(args);
    } catch {
      return null;
    }
  };

  function isRepo(): boolean {
    return tryGit(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  }

  // True only when `cwd` is the root of ITS OWN repo. `--is-inside-work-tree`
  // (isRepo) is also true inside a PARENT repo — e.g. a vault under a project
  // checkout — which would make init skip and every commit land in that parent,
  // sweeping the parent's working tree into "memory:" commits. Compare the repo
  // toplevel to cwd so a nested vault gets its own dedicated repo.
  function isRepoRoot(): boolean {
    const top = tryGit(["rev-parse", "--show-toplevel"])?.trim();
    // realpath both sides so a symlinked vault still matches; cwd is guaranteed
    // to exist (mkdirSync'd in the factory above), so realpathSync won't throw.
    return top != null && fs.realpathSync(top) === fs.realpathSync(opts.cwd);
  }

  function ensureIdentity(): void {
    if (tryGit(["config", "user.email"])?.trim()) return;
    git(["config", "user.email", "librarian@localhost"]);
    git(["config", "user.name", "The Librarian"]);
  }

  function init(): void {
    if (!isRepoRoot()) git(["init"]);
    ensureIdentity();
  }

  function commitAll(message: string): string | null {
    git(["add", "-A"]);
    if (!(tryGit(["status", "--porcelain"]) ?? "").trim()) return null;
    git(["commit", "-m", message]);
    return head();
  }

  function head(): string | null {
    return tryGit(["rev-parse", "HEAD"])?.trim() ?? null;
  }

  function log(): string[] {
    const out = tryGit(["log", "--format=%s"]);
    if (out === null) return []; // no commits yet
    return out.split("\n").filter((line) => line.length > 0);
  }

  return { init, commitAll, head, log, isRepo };
}
