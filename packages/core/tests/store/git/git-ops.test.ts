// Git-ops service tests (spec 035 §F12 — Phase 1).
//
// The vault is a real git repo (history/audit for free; `git push` backup
// in Phase 7). This service auto-inits the repo (idempotent, with a
// fallback commit identity so headless/CI commits never fail) and commits
// every file op. Pins: init idempotency, commit-per-op, no empty commits,
// deletions staged, and log/head reads. Runs real `git` via simple-git.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitOps } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every test here spawns real `git` subprocesses (init + commit per op via
// simple-git). Process spawns are fast in isolation (~hundreds of ms) but
// legitimately spike past the 5s default when the full suite runs ~16 files in
// parallel and the machine is I/O-bound — a recurring CI/local flake that is a
// too-tight timeout, not a logic bug. Give the subprocess work generous headroom
// for the whole file (still ~100× the real cost, so a genuine hang still fails).
vi.setConfig({ testTimeout: 30_000 });

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-gitops-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const write = (rel: string, content: string): void => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};

describe("git-ops service", () => {
  it("init creates a git repo and is idempotent", async () => {
    const git = createGitOps({ cwd });
    expect(await git.isRepo()).toBe(false);
    await git.init();
    expect(await git.isRepo()).toBe(true);
    await git.init(); // second call must not throw
    expect(await git.isRepo()).toBe(true);
  });

  it("init creates a DEDICATED repo when nested in a parent repo, so commits don't bubble", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-gitops-parent-"));
    execFileSync("git", ["init"], { cwd: parent, stdio: "ignore" });
    const vault = path.join(parent, "data", "vault");
    try {
      const git = createGitOps({ cwd: vault });
      await git.init();
      expect(fs.existsSync(path.join(vault, ".git"))).toBe(true); // its own repo

      fs.writeFileSync(path.join(vault, "note.md"), "x");
      expect(await git.commitAll("memory: store")).not.toBeNull();
      expect(await git.log()).toContain("memory: store");

      // The parent repo's history stays empty — the commit didn't bubble up.
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

  it("head is null on a fresh repo with no commits", async () => {
    const git = createGitOps({ cwd });
    await git.init();
    expect(await git.head()).toBeNull();
    expect(await git.log()).toEqual([]);
  });

  it("commitAll commits new files and records the message", async () => {
    const git = createGitOps({ cwd });
    await git.init();
    write("people/elaine.md", "# Elaine\n");
    const hash = await git.commitAll("memory: inbox elaine");
    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await git.head()).toBe(hash);
    expect(await git.log()).toEqual(["memory: inbox elaine"]);
  });

  it("commitAll is a no-op (returns null) when nothing changed", async () => {
    const git = createGitOps({ cwd });
    await git.init();
    write("a.md", "x\n");
    await git.commitAll("first");
    expect(await git.commitAll("second")).toBeNull();
    expect(await git.log()).toEqual(["first"]);
  });

  it("records successive changes as separate commits, newest first", async () => {
    const git = createGitOps({ cwd });
    await git.init();
    write("a.md", "one\n");
    await git.commitAll("add a");
    write("a.md", "two\n");
    await git.commitAll("edit a");
    expect(await git.log()).toEqual(["edit a", "add a"]);
  });

  it("stages deletions (the archive/move path)", async () => {
    const git = createGitOps({ cwd });
    await git.init();
    write("gone.md", "bye\n");
    await git.commitAll("add gone");
    fs.rmSync(path.join(cwd, "gone.md"));
    const hash = await git.commitAll("remove gone");
    expect(hash).not.toBeNull();
    // The deletion is committed: the file is absent from the working tree.
    expect(fs.existsSync(path.join(cwd, "gone.md"))).toBe(false);
    expect(await git.log()).toEqual(["remove gone", "add gone"]);
  });
});
