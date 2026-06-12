// Git history tests (rethink T20, spec §8 / D16) — the read-only plumbing
// behind the dashboard's per-file history / diff / restore: commit lists that
// follow renames (with the path the file had at each commit), content at a
// commit, and unified diffs (commit↔commit, commit↔worktree, birth↔commit).
// Runs real `git` on a fixture repo via the same sync committer production uses.

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
    write("memories/anna.md", "v1\n");
    const c1 = git.commitAll("memory: store mem_1");
    write("other.md", "noise\n"); // a commit that does NOT touch the file
    git.commitAll("vault: create other.md");
    write("memories/anna.md", "v2\n");
    const c2 = git.commitAll("memory: update mem_1");

    const history = createGitHistory({ cwd }).fileHistory("memories/anna.md");
    expect(history.map((c) => c.hash)).toEqual([c2, c1]);
    expect(history.map((c) => c.subject)).toEqual(["memory: update mem_1", "memory: store mem_1"]);
    expect(history[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Whatever identity the repo resolved (the store's fallback or an ambient
    // git config) — provenance lives in the subject, not the author.
    expect(history[0]?.author).toBeTruthy();
    expect(history[0]?.path).toBe("memories/anna.md");
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
