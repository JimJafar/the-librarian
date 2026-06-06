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
import os from "node:os";
import path from "node:path";

/** Credentials for an authenticated push to an HTTPS git remote. */
export interface GitPushAuth {
  /** Full HTTPS remote URL — username only, NEVER the token (e.g. `https://x-access-token@github.com/owner/repo.git`). */
  remoteUrl: string;
  /** Local ref to push (defaults to `HEAD`). */
  ref?: string;
  /** Remote branch to push to. */
  branch: string;
  /** The token — supplied to git via GIT_ASKPASS, never on the URL / argv / config. */
  token: string;
}

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
  /**
   * The full hash of the most recent commit that touched `relPath`, or `null`
   * when the path has no history yet (never committed, or a commitless repo).
   * Used as the addendum's version (spec 044 D-1): a stable hash later PRs tag
   * proposals with and `git checkout` to roll back.
   */
  lastCommitFor(relPath: string): string | null;
  /** Commit subjects, newest first (empty on a repo with no commits). */
  log(): string[];
  isRepo(): boolean;
  /**
   * Push `ref` (default HEAD) to `branch` on `remoteUrl`. The token is fed to git
   * via a transient GIT_ASKPASS helper that reads it from the child's env — so it
   * never appears in the URL, `.git/config` (no named remote is added), the
   * command line (`ps`), or git's error output. The URL carries only the
   * `x-access-token@` username, so git asks the helper for the password only.
   */
  push(auth: GitPushAuth): void;
}

export function createSyncGitOps(opts: { cwd: string }): SyncGitOps {
  fs.mkdirSync(opts.cwd, { recursive: true });

  const git = (args: string[], env?: NodeJS.ProcessEnv): string =>
    // stderr piped (not inherited) so routine git noise — `init` branch
    // hints, the pre-init `rev-parse` "fatal: not a git repository" probe —
    // stays off the console; on failure it's still attached to the thrown
    // error's `.stderr`.
    execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
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

  function lastCommitFor(relPath: string): string | null {
    // `-1 --format=%H -- <path>` prints the newest touching commit's hash, or
    // empty (exit 0) when the path has no history; tryGit also absorbs the
    // commitless-repo case (exit non-zero) → null.
    const out = tryGit(["log", "-1", "--format=%H", "--", relPath])?.trim();
    return out ? out : null;
  }

  function log(): string[] {
    const out = tryGit(["log", "--format=%s"]);
    if (out === null) return []; // no commits yet
    return out.split("\n").filter((line) => line.length > 0);
  }

  function push(auth: GitPushAuth): void {
    // The remote URL carries only the `x-access-token@` username and is passed
    // inline (never `git remote add`-ed), so `.git/config` stays clean; the token
    // is fed to git via GIT_ASKPASS (env-only) and scrubbed from errors at source.
    runGitWithToken(
      ["push", auth.remoteUrl, `${auth.ref ?? "HEAD"}:refs/heads/${auth.branch}`],
      auth.token,
      opts.cwd,
    );
  }

  return { init, commitAll, head, lastCommitFor, log, isRepo, push };
}

/**
 * Run a git command with a token supplied via a transient GIT_ASKPASS helper. The
 * helper reads the token from the child env (`LIBRARIAN_GIT_TOKEN`), not its argv,
 * so the token never lands in the URL, `.git/config`, the command line (`ps`), or
 * git's error output (scrubbed from message + stderr at the source). Shared by
 * push + clone.
 */
function runGitWithToken(args: string[], token: string, cwd?: string): string {
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-askpass-"));
  const helper = path.join(askDir, "askpass.sh");
  fs.writeFileSync(helper, '#!/bin/sh\nprintf "%s" "$LIBRARIAN_GIT_TOKEN"\n', { mode: 0o700 });
  try {
    return execFileSync("git", args, {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_ASKPASS: helper,
        GIT_TERMINAL_PROMPT: "0",
        LIBRARIAN_GIT_TOKEN: token,
      },
    });
  } catch (err) {
    if (err instanceof Error && token) {
      err.message = err.message.split(token).join("***");
      const withStderr = err as Error & { stderr?: unknown };
      if (typeof withStderr.stderr === "string") {
        withStderr.stderr = withStderr.stderr.split(token).join("***");
      }
    }
    throw err;
  } finally {
    fs.rmSync(askDir, { recursive: true, force: true });
  }
}

/**
 * Clone the backup remote (the git-pushed vault) into `dest`, token-safe via the
 * same GIT_ASKPASS path as push. `dest` must not already exist (git refuses).
 */
export function cloneVaultBackup(opts: {
  remoteUrl: string;
  branch: string;
  token: string;
  dest: string;
}): void {
  fs.mkdirSync(path.dirname(opts.dest), { recursive: true });
  runGitWithToken(
    ["clone", "--branch", opts.branch, "--single-branch", opts.remoteUrl, opts.dest],
    opts.token,
  );
}
