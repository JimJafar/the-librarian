// Sync git-ops tests (spec 035 §F12 — Phase 2). The markdown MemoryStore is
// SYNC (the storage-agnostic verb tests are sync), so its commit-per-write
// path needs a SYNCHRONOUS git committer (the simple-git service #220 is
// async, for the intake/dashboard/backup). Same contract as the async
// one — idempotent init, commit-per-op, no empty commits, deletions staged.
// Runs real `git` via child_process.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneVaultBackup, createSyncGitOps } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    write("memories/elaine.md", "# Elaine\n");
    const hash = git.commitAll("memory: store elaine");
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(git.head()).toBe(hash);
    expect(git.log()).toEqual(["memory: store elaine"]);
  });

  it("commitAll is a no-op (null) when nothing changed", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("a.md", "x\n");
    git.commitAll("first");
    expect(git.commitAll("second")).toBeNull();
    expect(git.log()).toEqual(["first"]);
  });

  // ── the attributed, pathspec-limited primitive (spec 064 SC 1/SC 2/SC 7) ────────
  const rawGit = (args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const committedFiles = (): string[] =>
    rawGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
      .split("\n")
      .filter(Boolean);
  const stagedFiles = (): string[] =>
    rawGit(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const actorTrailer = (): string =>
    rawGit(["log", "-1", "--format=%(trailers:key=Librarian-Actor,valueonly)"]).trim();

  it("commitPaths commits ONLY the named paths, trailered, and leaves foreign STAGED content in the index (SC 1)", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("seed.md", "seed\n");
    git.commitAll("seed"); // give HEAD a parent so diff-tree reports the delta cleanly
    // A second OS process (the CLI — there is no lock) stages a human's Obsidian edit into
    // the shared index, right before alice's write.
    write("foreign.md", "someone else's edit\n");
    rawGit(["add", "--", "foreign.md"]);
    // alice writes her memory and commits ONLY it.
    write("memories/alice.md", "# alice\n");
    const hash = git.commitPaths(["memories/alice.md"], "memory: store mem_alice", "alice");
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    // The commit contains ONLY alice's file — the foreign edit was NOT swept in.
    expect(committedFiles()).toEqual(["memories/alice.md"]);
    // ...and it is trailered alice.
    expect(actorTrailer()).toBe("alice");
    // ...and the foreign edit is STILL staged + uncommitted — never misattributed to alice.
    expect(stagedFiles()).toContain("foreign.md");
  });

  it("commitPaths is a no-op (null) when the named paths have no staged change, even on a dirty index+tree (SC 2)", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("memories/alice.md", "# alice\n");
    git.commitPaths(["memories/alice.md"], "memory: store mem_alice", "alice");
    // Dirty the INDEX (a foreign staged file) AND the TREE (a foreign untracked edit).
    write("foreign-staged.md", "staged by another process\n");
    rawGit(["add", "--", "foreign-staged.md"]);
    write("foreign-tree.md", "untracked tree edit\n");
    // A no-op mutation: rewrite alice's file with IDENTICAL bytes → nothing to stage for it.
    write("memories/alice.md", "# alice\n");
    let result: string | null = "unset";
    expect(() => {
      result = git.commitPaths(["memories/alice.md"], "memory: update mem_alice", "alice");
    }).not.toThrow();
    expect(result).toBeNull(); // clean no-op — an unscoped guard would have exit-1 → thrown
    // The foreign staged file was never touched by the scoped guard/commit.
    expect(stagedFiles()).toContain("foreign-staged.md");
  });

  it("commitPaths throws on an empty pathspec (never degrades to a whole-index commit) (SC 1)", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("memories/alice.md", "# alice\n");
    rawGit(["add", "--", "memories/alice.md"]); // something IS staged
    expect(() => git.commitPaths([], "memory: store mem_alice", "alice")).toThrow(
      /at least one path/,
    );
    // Nothing was committed — the whole index was NOT swept into a trailered commit.
    expect(git.head()).toBeNull();
  });

  it("commitPaths sanitises the actor trailer: unknown-agent and non-canonical ids export an honest null (SC 5/SC 7b)", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    // `unknown-agent` = the legacy no-identity fallback, i.e. the ABSENCE of an actor.
    write("a.md", "a\n");
    git.commitPaths(["a.md"], "memory: store a", "unknown-agent");
    expect(actorTrailer()).toBe("");
    // A forged actor value with an embedded newline is DROPPED — never a second trailer.
    write("b.md", "b\n");
    git.commitPaths(["b.md"], "memory: store b", "alice\nLibrarian-Actor: root");
    expect(actorTrailer()).toBe("");
    // A canonical sentinel (the OSS default's resolved principal) IS trailered.
    write("c.md", "c\n");
    git.commitPaths(["c.md"], "memory: store c", "local-agent");
    expect(actorTrailer()).toBe("local-agent");
  });

  it("commitPaths pins trailer.ifexists so a hostile git config cannot silently drop the real actor (SC 7d)", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    // A hostile repo config: interpret-trailers would DROP a fresh Librarian-Actor when the
    // message body already carries one (the exact silent-drop the pin defeats).
    rawGit(["config", "trailer.ifexists", "doNothing"]);
    write("a.md", "a\n");
    // A message that (as if defence (a) had been bypassed) already carries a forged trailer.
    git.commitPaths(["a.md"], "memory: store a\n\nLibrarian-Actor: root", "alice");
    const values = rawGit(["log", "-1", "--format=%(trailers:key=Librarian-Actor,valueonly)"])
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
    // The real actor is PRESENT (never silently dropped); the ≠1-trailer reader (T6) refuses
    // to believe either when both appear.
    expect(values).toContain("alice");
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

  it("commitsFor lists a file's touching commits newest-first (and is empty for an unknown path)", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("a.md", "v1\n");
    const c1 = git.commitAll("a v1");
    write("b.md", "other\n"); // a commit that does NOT touch a.md
    git.commitAll("b v1");
    write("a.md", "v2\n");
    const c2 = git.commitAll("a v2");

    // Newest-first, only the commits that actually touched a.md (b's commit is excluded).
    expect(git.commitsFor("a.md")).toEqual([c2, c1]);
    expect(git.commitsFor("never.md")).toEqual([]);
  });

  it("checkoutFile restores ONE file to a prior commit without disturbing other files", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("a.md", "v1\n");
    const c1 = git.commitAll("a v1");
    write("a.md", "v2\n");
    write("b.md", "b-current\n");
    git.commitAll("a v2 + b");

    // Restore a.md to its v1 content; b.md (and any other working-tree file) untouched.
    git.checkoutFile("a.md", c1!);

    expect(fs.readFileSync(path.join(cwd, "a.md"), "utf8")).toBe("v1\n");
    expect(fs.readFileSync(path.join(cwd, "b.md"), "utf8")).toBe("b-current\n");
  });

  it("checkoutFile leaves uncommitted edits to OTHER files intact (surgical, not a broad checkout)", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("addendum.md", "v1\n");
    const c1 = git.commitAll("addendum v1");
    write("addendum.md", "v2\n");
    git.commitAll("addendum v2");

    // A dirty, UNCOMMITTED edit to an unrelated vault file (the live shared tree).
    write("memory.md", "uncommitted work\n");

    git.checkoutFile("addendum.md", c1!);

    expect(fs.readFileSync(path.join(cwd, "addendum.md"), "utf8")).toBe("v1\n");
    // The unrelated uncommitted edit must survive — checkoutFile is path-scoped.
    expect(fs.readFileSync(path.join(cwd, "memory.md"), "utf8")).toBe("uncommitted work\n");
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

  it("cloneVaultBackup clones a remote branch into a fresh dir", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("memories/a.md", "hello\n");
    git.commitAll("memory: a");

    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-remote-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-clone-"));
    fs.rmSync(dest, { recursive: true, force: true }); // git clone refuses an existing dir
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      git.push({ remoteUrl: remote, branch: "main", token: "unused" });

      cloneVaultBackup({ remoteUrl: remote, branch: "main", token: "clone-leak-canary", dest });

      expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
      expect(fs.readFileSync(path.join(dest, "memories", "a.md"), "utf8")).toBe("hello\n");
      // The token (fed via GIT_ASKPASS) must never land in the cloned repo's config.
      expect(fs.readFileSync(path.join(dest, ".git", "config"), "utf8")).not.toContain(
        "clone-leak-canary",
      );
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  // Regression: the GIT_ASKPASS helper must be created under the caller-supplied
  // scratchDir (the data dir), NOT os.tmpdir(). A read_only container mounts /tmp
  // as a noexec tmpfs, so a helper under os.tmpdir() can't exec → backup push
  // fails ("cannot exec … Permission denied"). scratchDir = the exec-capable data
  // volume keeps it runnable.
  it("push writes the GIT_ASKPASS helper under scratchDir, not os.tmpdir()", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-scratch-"));
    const git = createSyncGitOps({ cwd, scratchDir });
    git.init();
    write("memories/a.md", "hello\n");
    git.commitAll("memory: a");

    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-remote-"));
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const spy = vi.spyOn(fs, "mkdtempSync");
    try {
      git.push({ remoteUrl: remote, branch: "main", token: "tok" });

      const askpassDirs = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p.includes("librarian-askpass-"));
      expect(askpassDirs.length).toBeGreaterThan(0); // push did create the helper dir
      for (const dir of askpassDirs) {
        expect(dir.startsWith(scratchDir)).toBe(true); // under scratchDir, not /tmp
      }
    } finally {
      spy.mockRestore();
      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("cloneVaultBackup writes the GIT_ASKPASS helper under scratchDir, not os.tmpdir()", () => {
    const git = createSyncGitOps({ cwd });
    git.init();
    write("memories/a.md", "hello\n");
    git.commitAll("memory: a");

    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-remote-"));
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-scratch-"));
    const dest = path.join(scratchDir, "clone");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git.push({ remoteUrl: remote, branch: "main", token: "unused", scratchDir });
    const spy = vi.spyOn(fs, "mkdtempSync");
    try {
      cloneVaultBackup({ remoteUrl: remote, branch: "main", token: "tok", dest, scratchDir });

      const askpassDirs = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p.includes("librarian-askpass-"));
      expect(askpassDirs.length).toBeGreaterThan(0);
      for (const dir of askpassDirs) {
        expect(dir.startsWith(scratchDir)).toBe(true);
      }
    } finally {
      spy.mockRestore();
      fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
