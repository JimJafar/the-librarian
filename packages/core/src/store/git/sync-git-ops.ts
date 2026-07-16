// Synchronous git-ops for the markdown MemoryStore's commit-per-write path
// (spec 035 §F12). The store is sync (the storage-agnostic verb tests are
// sync), so it can't await the simple-git service (#220, which serves the
// async intake / dashboard / backup). This is the same contract,
// shelling out to `git` synchronously via child_process.
//
// A fallback commit identity is configured locally (only when none is set)
// so headless / CI commits never fail.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { actorTrailerValue } from "../../caller-identity.js";

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
   * Stage everything (incl. deletions) and commit — the WHOLE-TREE primitive for the
   * system sweeps that have no path set (inbox consolidate, backup snapshot, the two
   * restore commits, the migration sweeps — spec 064 SC 3). Returns the new HEAD hash,
   * or `null` when there was nothing to commit (no empty commits).
   *
   * `actorId` is OPTIONAL and defaults to an untrailered commit — the whole-tree sweeps
   * capture OTHER people's bytes (out-of-band edits), so they export `actor: null`
   * HONESTLY. The two whole-tree sites that DO know their actor (the whole-vault restore
   * = the admin; the consolidate sweep = `system-consolidator`) pass it, and it is
   * written as a sanitised `Librarian-Actor` trailer (see {@link actorTrailerValue}).
   */
  commitAll(message: string, actorId?: string): string | null;
  /**
   * Stage + commit ONLY the named paths, carrying an optional sanitised `Librarian-Actor`
   * trailer — the ATTRIBUTED primitive for every actor-bearing write (spec 064 SC 1).
   *
   * The COMMIT is pathspec-limited, not just the add: `git commit -- <paths>` is `--only`
   * mode, so it commits exactly the named paths from the working tree and leaves any
   * FOREIGN staged content in the index. The CLI is a second OS process on the same repo
   * with no lock, so a human's Obsidian edit it staged must never ride into this actor's
   * trailered commit — a false name is worse than an honest null.
   *
   * The emptiness guard is index-scoped to the SAME paths (`git diff --cached --quiet --
   * <paths>`), so a no-op mutation on a dirty index/tree returns `null` rather than
   * throwing (SC 2). An EMPTY `paths` THROWS — an empty pathspec would degrade to a
   * whole-index commit carrying the actor's trailer (SC 1). Returns the new HEAD hash, or
   * `null` when nothing was staged for those paths.
   *
   * Minimum git 2.32 (`git commit --trailer`, SC 2).
   */
  commitPaths(paths: string[], message: string, actorId?: string): string | null;
  /** Current HEAD hash, or `null` on a repo with no commits yet. */
  head(): string | null;
  /**
   * The full hash of the most recent commit that touched `relPath`, or `null`
   * when the path has no history yet (never committed, or a commitless repo).
   * Used as the addendum's version (spec 044 D-1): a stable hash later PRs tag
   * proposals with and `git checkout` to roll back.
   */
  lastCommitFor(relPath: string): string | null;
  /**
   * The full hashes of every commit that touched `relPath`, newest first (empty
   * when the path has no history). The first element is the file's current
   * version, the second its prior version — the spec 044 D-3b roll-back uses
   * `commitsFor(rel)[1]` to find the commit to restore the addendum to.
   */
  commitsFor(relPath: string): string[];
  /**
   * Restore a SINGLE file to its content at `commitHash`, leaving every other
   * file (committed or dirty) in the working tree untouched (spec 044 D-3b roll-
   * back). This is `git checkout <hash> -- <relPath>`: path-scoped on purpose —
   * the vault is the live shared working tree, so a broad checkout that could
   * clobber unrelated uncommitted state is forbidden. The restored content is left
   * staged + in the working tree; the caller commits it. Returns void.
   */
  checkoutFile(relPath: string, commitHash: string): void;
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

export function createSyncGitOps(opts: {
  cwd: string;
  /**
   * Exec-capable dir for the transient GIT_ASKPASS helper used by `push` — pass
   * the data dir. Defaults to os.tmpdir(). See `runGitWithToken` for why this
   * matters under `read_only` containers (noexec /tmp).
   */
  scratchDir?: string;
}): SyncGitOps {
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

  // The `git` argv for an actor trailer, split into the pre-subcommand `-c` config and the
  // post-subcommand `--trailer` (spec 064 SC 7). Empty when the actor is not trailer-eligible
  // (an honest null — see actorTrailerValue). `--trailer` routes through `interpret-trailers`,
  // which honours the repo/global/system `trailer.*` config the Librarian does not control
  // (process.env is passed through, so `.git/config`, ~/.gitconfig and GIT_CONFIG_* all apply).
  // Our commit messages are a ONE-LINE subject with no existing trailer, so the config that
  // governs whether our trailer is ADDED is `trailer.ifmissing` — a hostile/inherited
  // `trailer.ifmissing=doNothing` SILENTLY DROPS the actor (verified on git 2.43). We therefore
  // pin `ifmissing=add` (command-line `-c` outranks every config file, restoring the trailer even
  // under an inherited `doNothing`). `ifexists=addIfDifferent` is also pinned for the defence-in-
  // depth case of a message that somehow already carries the trailer (dedupe rather than double).
  function actorTrailerArgs(actorId?: string): { config: string[]; trailer: string[] } {
    const value = actorTrailerValue(actorId);
    if (value === undefined) return { config: [], trailer: [] };
    return {
      config: ["-c", "trailer.ifmissing=add", "-c", "trailer.ifexists=addIfDifferent"],
      trailer: ["--trailer", `Librarian-Actor=${value}`],
    };
  }

  function commitAll(message: string, actorId?: string): string | null {
    git(["add", "-A"]);
    if (!(tryGit(["status", "--porcelain"]) ?? "").trim()) return null;
    const { config, trailer } = actorTrailerArgs(actorId);
    git([...config, "commit", "-m", message, ...trailer]);
    return head();
  }

  function commitPaths(paths: string[], message: string, actorId?: string): string | null {
    if (paths.length === 0) {
      // An empty pathspec makes `git commit --` commit the ENTIRE index (verified on git
      // 2.43) — the exact misattribution the two-primitive split exists to prevent. Never
      // degrade a path-scoped, trailered commit into a whole-index one.
      throw new Error(
        "commitPaths requires at least one path (an empty pathspec would commit the whole index)",
      );
    }
    // Stage the named paths (including deletions + new files) so the index-scoped guard and
    // the commit both see them.
    git(["add", "--", ...paths]);
    // Index-scoped emptiness guard (SC 2): ONLY the named paths decide "nothing to commit",
    // so a no-op mutation on a dirty index/tree returns null instead of exiting 1 → throwing.
    // `git diff --cached --quiet -- <paths>` exits 0 (tryGit → non-null) when nothing is
    // staged for those paths, 1 (tryGit → null) when there is.
    if (tryGit(["diff", "--cached", "--quiet", "--", ...paths]) !== null) return null;
    const { config, trailer } = actorTrailerArgs(actorId);
    // Pathspec-limited COMMIT (SC 1), not just a scoped add: `git commit -- <paths>` is
    // --only mode, so it commits ONLY the named paths and leaves foreign staged content in
    // the index.
    git([...config, "commit", "-m", message, ...trailer, "--", ...paths]);
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

  function commitsFor(relPath: string): string[] {
    // `--format=%H -- <path>` prints every touching commit's hash newest-first,
    // or empty (exit 0) when the path has no history; tryGit also absorbs the
    // commitless-repo case (exit non-zero) → [].
    const out = tryGit(["log", "--format=%H", "--", relPath]);
    if (out === null) return [];
    return out.split("\n").filter((line) => line.length > 0);
  }

  function checkoutFile(relPath: string, commitHash: string): void {
    // `checkout <hash> -- <relPath>` restores ONLY that path from that commit; the
    // `--` separates the pathspec so a path that looks like a ref can't be
    // misread, and no other working-tree file (committed or dirty) is touched.
    git(["checkout", commitHash, "--", relPath]);
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
      { cwd: opts.cwd, scratchDir: opts.scratchDir },
    );
  }

  return {
    init,
    commitAll,
    commitPaths,
    head,
    lastCommitFor,
    commitsFor,
    checkoutFile,
    log,
    isRepo,
    push,
  };
}

/**
 * Run a git command with a token supplied via a transient GIT_ASKPASS helper. The
 * helper reads the token from the child env (`LIBRARIAN_GIT_TOKEN`), not its argv,
 * so the token never lands in the URL, `.git/config`, the command line (`ps`), or
 * git's error output (scrubbed from message + stderr at the source). Shared by
 * push + clone.
 */
function runGitWithToken(
  args: string[],
  token: string,
  runOpts: { cwd?: string | undefined; scratchDir?: string | undefined } = {},
): string {
  // The GIT_ASKPASS helper must be EXECUTABLE, which makes its location load-
  // bearing in a hardened deployment: a `read_only` container mounts /tmp as a
  // `noexec` tmpfs, so an askpass.sh under os.tmpdir() fails to exec ("cannot
  // exec … Permission denied") and the backup push falls back to a (disabled)
  // password prompt. Callers therefore pass `scratchDir` = the data dir — a
  // writable, exec-capable volume that sits OUTSIDE the vault working tree (the
  // vault repo is `<dataDir>/vault`), so the helper always runs and is never
  // swept into a commit. Falls back to os.tmpdir() for tests / non-container
  // callers that don't set it. The helper still reads the token from the child's
  // env (never embedded in the file), so its location carries no secret.
  const scratchBase = runOpts.scratchDir ?? os.tmpdir();
  const askDir = fs.mkdtempSync(path.join(scratchBase, "librarian-askpass-"));
  const helper = path.join(askDir, "askpass.sh");
  fs.writeFileSync(helper, '#!/bin/sh\nprintf "%s" "$LIBRARIAN_GIT_TOKEN"\n', { mode: 0o700 });
  try {
    return execFileSync("git", args, {
      ...(runOpts.cwd ? { cwd: runOpts.cwd } : {}),
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
  /**
   * Exec-capable dir for the transient GIT_ASKPASS helper (pass the data dir).
   * Defaults to os.tmpdir(). See `runGitWithToken` (noexec /tmp under read_only).
   */
  scratchDir?: string;
}): void {
  fs.mkdirSync(path.dirname(opts.dest), { recursive: true });
  runGitWithToken(
    ["clone", "--branch", opts.branch, "--single-branch", opts.remoteUrl, opts.dest],
    opts.token,
    { scratchDir: opts.scratchDir },
  );
}
