// Git-ops service for the markdown vault (spec 035 §F12). The vault is a
// real git repo — history/audit for free (retiring the events ledger) and
// `git push` backup in Phase 7. This service auto-inits the repo
// (idempotent) and commits every file op; it is shared by the consolidator
// (F5) and manual dashboard ops (F10).
//
// A fallback commit identity is configured (locally, only when none is
// set) so headless / CI commits never fail with "Please tell me who you
// are". Promise API throughout (simple-git over the git CLI).

import fs from "node:fs";
import { type SimpleGit, simpleGit } from "simple-git";

export interface GitOps {
  /** Idempotently `git init` the repo + ensure a commit identity exists. */
  init(): Promise<void>;
  /**
   * Stage everything (incl. deletions) and commit. Returns the new HEAD
   * hash, or `null` when there was nothing to commit (no empty commits).
   */
  commitAll(message: string): Promise<string | null>;
  /** Current HEAD hash, or `null` on a repo with no commits yet. */
  head(): Promise<string | null>;
  /** Commit subjects, newest first (empty on a repo with no commits). */
  log(): Promise<string[]>;
  isRepo(): Promise<boolean>;
}

export function createGitOps(opts: { cwd: string }): GitOps {
  fs.mkdirSync(opts.cwd, { recursive: true });
  const git: SimpleGit = simpleGit({ baseDir: opts.cwd });

  async function readConfig(key: string): Promise<string> {
    try {
      return (await git.raw(["config", key])).trim();
    } catch {
      return ""; // `git config <unset key>` exits non-zero
    }
  }

  async function ensureIdentity(): Promise<void> {
    if (await readConfig("user.email")) return;
    await git.addConfig("user.email", "librarian@localhost", false, "local");
    await git.addConfig("user.name", "The Librarian", false, "local");
  }

  async function init(): Promise<void> {
    if (!(await git.checkIsRepo())) await git.init();
    await ensureIdentity();
  }

  async function commitAll(message: string): Promise<string | null> {
    await git.raw(["add", "-A"]);
    if ((await git.status()).isClean()) return null;
    await git.commit(message);
    return head();
  }

  async function head(): Promise<string | null> {
    try {
      return (await git.revparse(["HEAD"])).trim();
    } catch {
      return null; // no commits yet
    }
  }

  async function log(): Promise<string[]> {
    try {
      return (await git.log()).all.map((entry) => entry.message);
    } catch {
      return []; // no commits yet
    }
  }

  return {
    init,
    commitAll,
    head,
    log,
    isRepo: () => git.checkIsRepo(),
  };
}
