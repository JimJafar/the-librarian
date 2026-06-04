// Sync git-ops tests (spec 035 §F12 — Phase 2). The markdown MemoryStore is
// SYNC (the storage-agnostic verb tests are sync), so its commit-per-write
// path needs a SYNCHRONOUS git committer (the simple-git service #220 is
// async, for the consolidator/dashboard/backup). Same contract as the async
// one — idempotent init, commit-per-op, no empty commits, deletions staged.
// Runs real `git` via child_process.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSyncGitOps } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-syncgit-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const write = (rel: string, content: string): void => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};

describe("sync git-ops", () => {
  it("init creates a repo and is idempotent", () => {
    const git = createSyncGitOps({ cwd });
    expect(git.isRepo()).toBe(false);
    git.init();
    expect(git.isRepo()).toBe(true);
    git.init();
    expect(git.isRepo()).toBe(true);
  });

  it("init creates a DEDICATED repo when nested in a parent repo, so commits don't bubble", () => {
    // A parent repo with the vault dir nested inside it (e.g. a data/ dir under a
    // project checkout). Without IS_REPO_ROOT, init sees the parent and skips —
    // then every commitAll lands in the parent, sweeping its working tree.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-parent-"));
    execFileSync("git", ["init"], { cwd: parent, stdio: "ignore" });
    const vault = path.join(parent, "data", "vault");
    try {
      const git = createSyncGitOps({ cwd: vault });
      git.init();
      expect(fs.existsSync(path.join(vault, ".git"))).toBe(true); // its own repo

      fs.writeFileSync(path.join(vault, "note.md"), "x");
      expect(git.commitAll("memory: store")).not.toBeNull();
      expect(git.log()).toContain("memory: store"); // landed in the vault repo

      // ...and NOT in the parent: its history stays empty (no HEAD yet).
      const parentHead = (() => {
        try {
          return execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: parent,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          return null;
        }
      })();
      expect(parentHead).toBeNull();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("head is null and log empty on a fresh repo", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    expect(git.head()).toBeNull();
    expect(git.log()).toEqual([]);
  });

  it("commitAll commits new files and records the message", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("memories/anna.md", "# Anna\n");
    const hash = git.commitAll("memory: store anna");
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(git.head()).toBe(hash);
    expect(git.log()).toEqual(["memory: store anna"]);
  });

  it("commitAll is a no-op (null) when nothing changed", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("a.md", "x\n");
    git.commitAll("first");
    expect(git.commitAll("second")).toBeNull();
    expect(git.log()).toEqual(["first"]);
  });

  it("records successive changes newest-first and stages deletions", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("a.md", "one\n");
    git.commitAll("add a");
    fs.rmSync(path.join(cwd, "a.md"));
    git.commitAll("remove a");
    expect(git.log()).toEqual(["remove a", "add a"]);
  });

  it("push delivers HEAD to a remote branch without persisting a named remote or the token", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("memories/a.md", "hello\n");
    git.commitAll("memory: a");
    const head = git.head();

    // A local bare repo stands in for the HTTPS remote. A tokenless local push
    // never invokes GIT_ASKPASS, so this exercises the push mechanics + refspec;
    // the token-handling is verified by construction (env-only, no URL/argv).
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-remote-"));
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });

      git.push({ remoteUrl: remote, branch: "main", token: "leak-canary-token" });

      const remoteHead = execFileSync(
        "git",
        ["--git-dir", remote, "rev-parse", "refs/heads/main"],
        { encoding: "utf8" },
      ).trim();
      expect(remoteHead).toBe(head);

      // No named remote was added and the token never landed in .git/config.
      const config = fs.readFileSync(path.join(cwd, ".git", "config"), "utf8");
      expect(config).not.toMatch(/\[remote /);
      expect(config).not.toContain("leak-canary-token");
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });
});
