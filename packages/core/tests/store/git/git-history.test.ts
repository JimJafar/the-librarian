// Git history tests (rethink T20, spec §8 / D16) — the read-only plumbing
// behind the dashboard's per-file history / diff / restore: commit lists that
// follow renames (with the path the file had at each commit), content at a
// commit, and unified diffs (commit↔commit, commit↔worktree, birth↔commit).
// Runs real `git` on a fixture repo via the same sync committer production uses.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SyncGitOps,
  GitHashError,
  assertCommitHash,
  createGitHistory,
  createSyncGitOps,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;
let git: SyncGitOps;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-githistory-"));
  git = createSyncGitOps({ cwd });
  git.init();
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const write = (rel: string, content: string): void => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};

describe("assertCommitHash", () => {
  it("accepts full and abbreviated hex hashes, lowercased", () => {
    expect(assertCommitHash("ABCDEF1")).toBe("abcdef1");
    expect(assertCommitHash("a".repeat(40))).toBe("a".repeat(40));
  });

  it("rejects refs, ranges, and flag-shaped input (argv injection defence)", () => {
    for (const bad of ["HEAD", "main", "abc123..def456", "--help", "abc12", ""]) {
      expect(() => assertCommitHash(bad), bad).toThrow(GitHashError);
    }
  });
});

describe("fileHistory", () => {
  it("lists the commits touching a file newest-first with hash, ISO date, author, subject", () => {
    write("memories/elaine.md", "v1\n");
    const c1 = git.commitAll("memory: store mem_1");
    write("other.md", "noise\n"); // a commit that does NOT touch the file
    git.commitAll("vault: create other.md");
    write("memories/elaine.md", "v2\n");
    const c2 = git.commitAll("memory: update mem_1");

    const history = createGitHistory({ cwd }).fileHistory("memories/elaine.md");
    expect(history.map((c) => c.hash)).toEqual([c2, c1]);
    expect(history.map((c) => c.subject)).toEqual(["memory: update mem_1", "memory: store mem_1"]);
    expect(history[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Whatever identity the repo resolved (the store's fallback or an ambient
    // git config) — provenance lives in the subject, not the author.
    expect(history[0]?.author).toBeTruthy();
    expect(history[0]?.path).toBe("memories/elaine.md");
  });

  it("follows renames and reports the path the file had AT each commit", () => {
    write("memories/old-name.md", "stable content, long enough for rename detection\n");
    git.commitAll("memory: store mem_2");
    fs.renameSync(path.join(cwd, "memories/old-name.md"), path.join(cwd, "memories/new-name.md"));
    git.commitAll("vault: rename memories/old-name.md -> memories/new-name.md");
    write("memories/new-name.md", "stable content, long enough for rename detection — edited\n");
    git.commitAll("memory: update mem_2");

    const history = createGitHistory({ cwd }).fileHistory("memories/new-name.md");
    expect(history).toHaveLength(3);
    // Newest two commits know the file by its new name; the pre-rename commit by its old one.
    expect(history.map((c) => c.path)).toEqual([
      "memories/new-name.md",
      "memories/new-name.md",
      "memories/old-name.md",
    ]);
  });

  it("is empty for an unknown path and on a commitless repo", () => {
    const history = createGitHistory({ cwd });
    expect(history.fileHistory("never.md")).toEqual([]); // commitless repo
    write("a.md", "x\n");
    git.commitAll("add a");
    expect(history.fileHistory("never.md")).toEqual([]);
  });
});

describe("fileAtCommit", () => {
  it("returns the content at a commit, and null when absent there", () => {
    write("a.md", "v1\n");
    const c1 = git.commitAll("a v1");
    write("a.md", "v2\n");
    write("b.md", "born later\n");
    const c2 = git.commitAll("a v2 + b");

    const history = createGitHistory({ cwd });
    expect(history.fileAtCommit("a.md", c1!)).toBe("v1\n");
    expect(history.fileAtCommit("a.md", c2!)).toBe("v2\n");
    expect(history.fileAtCommit("b.md", c1!)).toBeNull(); // b did not exist yet
  });
});

describe("fileDiff", () => {
  it("diffs a file between two commits as unified diff text", () => {
    write("a.md", "old line\n");
    const c1 = git.commitAll("a v1");
    write("a.md", "new line\n");
    const c2 = git.commitAll("a v2");

    const diff = createGitHistory({ cwd }).fileDiff("a.md", { from: c1!, to: c2! });
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  it("diffs a commit against the worktree when `to` is omitted", () => {
    write("a.md", "committed\n");
    const c1 = git.commitAll("a v1");
    write("a.md", "dirty uncommitted edit\n");

    const diff = createGitHistory({ cwd }).fileDiff("a.md", { from: c1! });
    expect(diff).toContain("-committed");
    expect(diff).toContain("+dirty uncommitted edit");
  });

  it("renders a file's birth as all-additions when `from` is omitted (empty tree)", () => {
    write("a.md", "first line\n");
    const c1 = git.commitAll("a v1");

    const diff = createGitHistory({ cwd }).fileDiff("a.md", { to: c1! });
    expect(diff).toContain("+first line");
    expect(diff).not.toContain("-first line");
  });

  it("returns an empty string for identical versions", () => {
    write("a.md", "same\n");
    const c1 = git.commitAll("a v1");
    expect(createGitHistory({ cwd }).fileDiff("a.md", { from: c1!, to: c1! })).toBe("");
  });

  it("sees across a rename when given the pre-rename path", () => {
    write("old.md", "stable body for rename detection across commits\n");
    const c1 = git.commitAll("add old");
    fs.renameSync(path.join(cwd, "old.md"), path.join(cwd, "new.md"));
    write("new.md", "stable body for rename detection across commits — edited\n");
    const c2 = git.commitAll("rename + edit");

    const diff = createGitHistory({ cwd }).fileDiff("new.md", {
      from: c1!,
      to: c2!,
      fromPath: "old.md",
    });
    expect(diff).toContain("+stable body for rename detection across commits — edited");
  });

  it("rejects flag-shaped revisions before they reach git", () => {
    expect(() => createGitHistory({ cwd }).fileDiff("a.md", { from: "--exec=true" })).toThrow(
      GitHashError,
    );
  });
});

describe("recentCommits / commitExists (the activity feed plumbing)", () => {
  it("lists vault commits newest-first with the files each touched", () => {
    write("memories/a.md", "x\n");
    git.commitAll("memory: store mem_1");
    write("memories/a.md", "y\n");
    write("references/b.md", "z\n");
    const c2 = git.commitAll("vault: edit two files");

    const feed = createGitHistory({ cwd }).recentCommits();
    expect(feed).toHaveLength(2);
    expect(feed[0]).toMatchObject({ hash: c2, subject: "vault: edit two files" });
    expect(feed[0]?.files.sort()).toEqual(["memories/a.md", "references/b.md"]);
    expect(feed[1]?.files).toEqual(["memories/a.md"]);
  });

  it("respects limit and pages strictly-older with `before`", () => {
    const hashes: string[] = [];
    for (let i = 0; i < 4; i++) {
      write("a.md", `v${i}\n`);
      hashes.push(git.commitAll(`commit ${i}`)!);
    }
    const history = createGitHistory({ cwd });
    const page1 = history.recentCommits({ limit: 2 });
    expect(page1.map((c) => c.hash)).toEqual([hashes[3], hashes[2]]);
    const page2 = history.recentCommits({ limit: 2, before: page1[1]!.hash });
    expect(page2.map((c) => c.hash)).toEqual([hashes[1], hashes[0]]);
  });

  it("pages even when a committed file is named like the cursor hash", () => {
    // Without an argv terminator, `git log <hash>` errors as ambiguous when a
    // file by that name exists — and the feed would silently come back empty.
    write("a.md", "v0\n");
    const c1 = git.commitAll("commit 0")!;
    write("a.md", "v1\n");
    const c2 = git.commitAll("commit 1")!;
    write(c2, "a file named after a commit hash\n");
    git.commitAll("commit 2");

    const page = createGitHistory({ cwd }).recentCommits({ limit: 2, before: c2 });
    expect(page.map((c) => c.hash)).toEqual([c1]);
  });

  it("is empty on a commitless repo; commitExists answers honestly", () => {
    const history = createGitHistory({ cwd });
    expect(history.recentCommits()).toEqual([]);
    write("a.md", "x\n");
    const c1 = git.commitAll("first");
    expect(history.commitExists(c1!)).toBe(true);
    expect(history.commitExists("deadbeef".repeat(5))).toBe(false);
  });
});

describe("tag / restoreTreeTo (the whole-vault restore plumbing)", () => {
  it("tag anchors the current HEAD; a taken name throws", () => {
    write("a.md", "x\n");
    const head = git.commitAll("first");
    const history = createGitHistory({ cwd });
    history.tag("pre-restore-20260612-120000");
    expect(
      execFileSync("git", ["rev-parse", "pre-restore-20260612-120000^{commit}"], {
        cwd,
        encoding: "utf8",
      }).trim(),
    ).toBe(head);
    expect(() => history.tag("pre-restore-20260612-120000")).toThrow();
    expect(() => history.tag("--force")).toThrow(GitHashError);
  });

  it("restoreTreeTo stages the target tree exactly: edits reverted, later files removed, commit left to the caller", () => {
    write("keep.md", "v1\n");
    const target = git.commitAll("state to restore");
    write("keep.md", "v2\n");
    write("later.md", "added after\n");
    git.commitAll("later state");

    const history = createGitHistory({ cwd });
    history.restoreTreeTo(target!);

    // Worktree matches the target…
    expect(fs.readFileSync(path.join(cwd, "keep.md"), "utf8")).toBe("v1\n");
    expect(fs.existsSync(path.join(cwd, "later.md"))).toBe(false);
    // …but nothing is committed yet (staged only — the caller owns the commit).
    expect(git.log()[0]).toBe("later state");
    const commit = git.commitAll("vault: restore to target");
    expect(commit).not.toBeNull();
  });
});

describe("commitDiff", () => {
  it("returns per-file diffs for a multi-file commit, with status + path", () => {
    write("a.md", "v1\n");
    write("b.md", "kept\n");
    git.commitAll("seed");
    write("a.md", "v2\n");
    write("c.md", "fresh\n");
    fs.rmSync(path.join(cwd, "b.md"));
    const c = git.commitAll("multi: edit a, add c, drop b");

    const { hash, files } = createGitHistory({ cwd }).commitDiff(c!);
    expect(hash).toBe(c);
    // Order matches git's diff-tree output; convert to a path-keyed map.
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["a.md"]?.status).toBe("modified");
    expect(byPath["a.md"]?.diff).toMatch(/-v1/);
    expect(byPath["a.md"]?.diff).toMatch(/\+v2/);
    expect(byPath["b.md"]?.status).toBe("deleted");
    expect(byPath["c.md"]?.status).toBe("added");
    expect(byPath["c.md"]?.diff).toMatch(/\+fresh/);
  });

  it("flags renames with fromPath", () => {
    write("old.md", "content\n");
    git.commitAll("seed");
    fs.renameSync(path.join(cwd, "old.md"), path.join(cwd, "new.md"));
    const c = git.commitAll("rename");
    const { files } = createGitHistory({ cwd }).commitDiff(c!);
    const renamed = files.find((f) => f.path === "new.md");
    expect(renamed?.status).toBe("renamed");
    expect(renamed?.fromPath).toBe("old.md");
  });

  it("rejects flag-shaped hashes before they reach git", () => {
    expect(() => createGitHistory({ cwd }).commitDiff("--unsafe")).toThrow(GitHashError);
  });

  it("returns an empty files array for an unknown commit (commitless repo)", () => {
    // A 40-hex string that isn't a real commit — git show fails soft via tryGit.
    const { files } = createGitHistory({ cwd }).commitDiff("f".repeat(40));
    expect(files).toEqual([]);
  });
});
