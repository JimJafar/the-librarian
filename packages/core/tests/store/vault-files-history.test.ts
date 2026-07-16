// Vault file store history/diff/restore tests (rethink T20, spec §8 / D16).
// The store surface over the git history module: per-file commit lists
// (rename-following), content-at-commit, unified diffs, and restore-as-a-NEW-
// commit through the same validated write path as every other mutation —
// including the teaching refusal when an old version no longer passes the
// path's CURRENT validation. Runs real git on a fixture vault.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SyncGitOps,
  type Vault,
  type VaultFileStore,
  VaultFileNotFoundError,
  VaultPathError,
  VaultValidationError,
  createGitHistory,
  createSyncGitOps,
  createVault,
  createVaultFileStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let vault: Vault;
let git: SyncGitOps;
let store: VaultFileStore;
let writes: string[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-vault-history-"));
  vault = createVault({ dataDir });
  git = createSyncGitOps({ cwd: vault.root });
  git.init();
  writes = [];
  store = createVaultFileStore({
    vault,
    commit: (paths, message) => {
      // Faithful to the store's new pathspec-limited primitive (spec 064 SC 1).
      git.commitPaths(paths, message);
    },
    history: createGitHistory({ cwd: vault.root }),
    onWrite: (relPath) => writes.push(relPath),
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("fileHistory / fileAtCommit / fileDiff", () => {
  it("lists a file's commits newest-first and serves any version's content", () => {
    store.createFile("references/doc.md", "# Doc v1\n");
    store.writeFile("references/doc.md", "# Doc v2\n");

    const history = store.fileHistory("references/doc.md");
    expect(history.map((c) => c.subject)).toEqual([
      "vault: edit references/doc.md",
      "vault: create references/doc.md",
    ]);

    const v1 = store.fileAtCommit("references/doc.md", history[1]!.hash);
    expect(v1.content).toBe("# Doc v1\n");
    const diff = store.fileDiff("references/doc.md", {
      from: history[1]!.hash,
      to: history[0]!.hash,
    });
    expect(diff).toContain("-# Doc v1");
    expect(diff).toContain("+# Doc v2");
  });

  it("follows a store rename: pre-rename versions stay addressable + diffable", () => {
    store.createFile("references/old-doc.md", "stable body long enough for rename detection\n");
    store.renameFile("references/old-doc.md", "references/new-doc.md");
    store.writeFile("references/new-doc.md", "stable body long enough for rename detection v2\n");

    const history = store.fileHistory("references/new-doc.md");
    expect(history).toHaveLength(3);
    expect(history[2]?.path).toBe("references/old-doc.md");

    // Content at the pre-rename commit resolves through the historic path…
    const v1 = store.fileAtCommit("references/new-doc.md", history[2]!.hash);
    expect(v1.path).toBe("references/old-doc.md");
    expect(v1.content).toBe("stable body long enough for rename detection\n");
    // …and the diff across the rename is not a blind spot.
    const diff = store.fileDiff("references/new-doc.md", { from: history[2]!.hash });
    expect(diff).toContain("+stable body long enough for rename detection v2");
  });

  it("applies the same path discipline as reads (no plumbing, no traversal)", () => {
    for (const bad of ["../outside.md", ".git/config", "inbox/raw.md"]) {
      expect(() => store.fileHistory(bad), bad).toThrow(VaultPathError);
      expect(() => store.fileDiff(bad), bad).toThrow(VaultPathError);
    }
  });

  it("refuses a historic path outside the editable surface before it reaches git argv", () => {
    // Hand-made history (outside the store): the file was born in inbox/ —
    // plumbing the explorer must never address — then moved into references/.
    vault.writeText("inbox/doc.md", "stable body long enough for rename detection\n");
    git.commitAll("hand: add inbox doc");
    fs.mkdirSync(path.join(vault.root, "references"), { recursive: true });
    fs.renameSync(
      path.join(vault.root, "inbox", "doc.md"),
      path.join(vault.root, "references", "doc.md"),
    );
    git.commitAll("hand: move into references");

    const history = store.fileHistory("references/doc.md");
    expect(history[1]?.path).toBe("inbox/doc.md"); // git reports the historic path…
    // …but neither content-at-commit nor diff will address it (defensive
    // re-validation of git-derived paths, mirroring every caller-supplied path).
    expect(() => store.fileAtCommit("references/doc.md", history[1]!.hash)).toThrow(VaultPathError);
    expect(() => store.fileDiff("references/doc.md", { from: history[1]!.hash })).toThrow(
      VaultPathError,
    );
  });

  it("teaches when constructed without a history reader", () => {
    const bare = createVaultFileStore({ vault, commit: () => {} });
    expect(() => bare.fileHistory("references/doc.md")).toThrow(/without a git history reader/);
  });
});

describe("restoreFileVersion", () => {
  it("restores as a NEW commit whose content matches the chosen version", () => {
    store.createFile("references/doc.md", "# Doc v1\n");
    store.writeFile("references/doc.md", "# Doc v2\n");
    const target = store.fileHistory("references/doc.md")[1]!; // the v1 commit

    store.restoreFileVersion("references/doc.md", target.hash);

    // Content is back at v1, written as a new head commit — never a rewrite.
    expect(store.readFile("references/doc.md").raw).toBe("# Doc v1\n");
    const history = store.fileHistory("references/doc.md");
    expect(history).toHaveLength(3);
    expect(history[0]?.subject).toBe(
      `vault: restore references/doc.md to ${target.hash.slice(0, 12)}`,
    );
    // The write fired the index-invalidation hook like every other mutation.
    expect(writes).toContain("references/doc.md");
  });

  it("resurrects a deleted file from its history", () => {
    store.createFile("references/doc.md", "recoverable\n");
    const created = store.fileHistory("references/doc.md")[0]!;
    store.deleteFile("references/doc.md");

    store.restoreFileVersion("references/doc.md", created.hash);
    expect(store.readFile("references/doc.md").raw).toBe("recoverable\n");
  });

  it("refuses a version that fails the path's CURRENT validation, teaching the manual path", () => {
    // A legacy version that predates validation, committed outside the store
    // (the store itself never writes invalid).
    vault.writeText("memories/legacy.md", "no frontmatter at all\n");
    git.commitAll("legacy import");
    const legacy = store.fileHistory("memories/legacy.md")[0]!;
    // Brought up to valid shape since…
    const valid = [
      "---",
      'id: "mem_abc12345"',
      'title: "Legacy"',
      'agent_id: "agent-x"',
      'status: "active"',
      'confidence: "medium"',
      "tags: []",
      "applies_to: []",
      "supersedes: []",
      "conflicts_with: []",
      "flags: []",
      "is_global: false",
      "requires_approval: false",
      'created_at: "2026-06-01T00:00:00.000Z"',
      'updated_at: "2026-06-01T00:00:00.000Z"',
      "curator_note: null",
      "---",
      "",
      "Valid now.",
      "",
    ].join("\n");
    store.writeFile("memories/legacy.md", valid);

    // …so restoring the invalid version is refused with the errors + guidance.
    expect(() => store.restoreFileVersion("memories/legacy.md", legacy.hash)).toThrow(
      VaultValidationError,
    );
    expect(() => store.restoreFileVersion("memories/legacy.md", legacy.hash)).toThrow(
      /was not restored: .* bring the old content forward manually/s,
    );
    // Nothing was written or committed by the refused restore.
    expect(store.readFile("memories/legacy.md").raw).toBe(valid);
    expect(store.fileHistory("memories/legacy.md")).toHaveLength(2);
  });

  it("refuses a commit where the file has no content", () => {
    store.createFile("references/unrelated.md", "other\n"); // doc.md doesn't exist yet here
    const unrelated = store.fileHistory("references/unrelated.md")[0]!;
    store.createFile("references/doc.md", "v1\n");
    expect(() => store.restoreFileVersion("references/doc.md", unrelated.hash)).toThrow(
      VaultFileNotFoundError,
    );
  });
});
