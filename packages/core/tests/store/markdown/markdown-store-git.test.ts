// Integration: the markdown MemoryStore commits per write (spec 035 §F1 /
// plan 036 Phase 2 — "a remember produces a markdown file + a commit").
// Wires the store to the sync git committer over the vault repo and asserts
// each write lands a file AND a git commit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarkdownMemoryStore, createSyncGitOps, createVault } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-git-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const vault = createVault({ dataDir });
  const git = createSyncGitOps({ cwd: vault.root });
  git.init();
  let counter = 0;
  const store = createMarkdownMemoryStore({
    vault,
    // Faithful to the store's pathspec-limited primitive (spec 064 SC 1): the store names
    // the file(s) it touched, and this wires them to the real committer.
    commit: (paths, message) => git.commitPaths(paths, message),
    generateId: () => `mem_g${++counter}`,
  });
  return { vault, git, store };
}

describe("markdown store + git — commit per write", () => {
  it("createMemory writes a markdown file AND records a commit", () => {
    const { vault, git, store } = setup();
    const { memory } = store.createMemory({
      agent_id: "codex",
      title: "Use pnpm",
      body: "Always pnpm.",
    });
    const files = fs.readdirSync(path.join(vault.root, "memories"));
    expect(files.some((f) => /^use-pnpm-.+\.md$/.test(f))).toBe(true); // human-readable slug name
    expect(git.head()).toMatch(/^[0-9a-f]{7,40}$/);
    expect(git.log()).toEqual([`memory: store ${memory.id}`]);
  });

  it("a proposed write commits with the propose verb", () => {
    const { git, store } = setup();
    const { memory } = store.createMemory(
      { agent_id: "codex", title: "Owner", body: "Guybrush owns this." },
      { requires_approval: true },
    );
    expect(git.log()).toEqual([`memory: propose ${memory.id}`]);
  });

  it("each mutation lands its own commit, newest first", () => {
    const { git, store } = setup();
    const { memory } = store.createMemory({ agent_id: "codex", title: "t", body: "b" });
    store.updateMemory(memory.id, { body: "edited" });
    store.archiveMemory(memory.id);
    expect(git.log()).toEqual([
      `memory: archive ${memory.id}`,
      `memory: update ${memory.id}`,
      `memory: store ${memory.id}`,
    ]);
  });

  it("unarchiveMemory records its own commit (revertable), idempotent on already-active", () => {
    const { git, store } = setup();
    const { memory } = store.createMemory({ agent_id: "codex", title: "t", body: "b" });
    store.archiveMemory(memory.id);
    const beforeUnarchive = git.log().length;
    store.unarchiveMemory(memory.id);
    expect(git.log()[0]).toBe(`memory: unarchive ${memory.id}`);
    expect(git.log().length).toBe(beforeUnarchive + 1);
    // Already active → no-op, no new commit.
    store.unarchiveMemory(memory.id);
    expect(git.log().length).toBe(beforeUnarchive + 1);
  });
});
