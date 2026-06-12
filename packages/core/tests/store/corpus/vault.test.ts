// Vault file-I/O tests (spec 035 §F1 / Project Structure — Phase 1).
//
// The vault is a folder of markdown at `<data-dir>/vault` (or
// LIBRARIAN_VAULT_PATH). This module is the read/write/list/move primitive
// the git-ops + link-integrity service (next increment) commits on top of.
// Pins: path resolution, document round-trip through the corpus
// serializer, recursive listing (stable, posix-relative), move (the
// archive=move primitive), and the path-escape guard (the vault is
// `git push`ed — writes must not escape its root).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CorpusDocument, createVault, resolveVaultPath } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-vault-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const doc = (id: string): CorpusDocument => ({
  frontmatter: {
    id,
    aliases: [],
    tags: ["t"],
    category: "people",
    created: "2026-06-01T00:00:00.000Z",
    updated: "2026-06-01T00:00:00.000Z",
  },
  body: `# ${id}\n\nbody for ${id}.`,
});

describe("resolveVaultPath", () => {
  it("prefers an explicit vaultPath", () => {
    expect(resolveVaultPath({ vaultPath: "/tmp/custom-vault", dataDir })).toBe("/tmp/custom-vault");
  });

  it("falls back to <dataDir>/vault", () => {
    expect(resolveVaultPath({ dataDir })).toBe(path.join(dataDir, "vault"));
  });

  it("honours LIBRARIAN_VAULT_PATH", () => {
    const prev = process.env.LIBRARIAN_VAULT_PATH;
    process.env.LIBRARIAN_VAULT_PATH = "/tmp/env-vault";
    try {
      expect(resolveVaultPath({ dataDir })).toBe("/tmp/env-vault");
    } finally {
      if (prev === undefined) delete process.env.LIBRARIAN_VAULT_PATH;
      else process.env.LIBRARIAN_VAULT_PATH = prev;
    }
  });

  it("always returns an ABSOLUTE path, even from a relative dataDir / vaultPath", () => {
    // within()'s escape check resolves subpaths to absolute then compares to
    // root, so a relative root would flag every subpath as an escape.
    expect(path.isAbsolute(resolveVaultPath({ dataDir: "./rel/data" }))).toBe(true);
    expect(path.isAbsolute(resolveVaultPath({ vaultPath: "rel/vault" }))).toBe(true);
  });
});

describe("vault with a relative dataDir (escape-guard regression)", () => {
  it("lists a hidden subdir (inbox/.processing) instead of throwing 'escapes the vault root'", () => {
    // The seed script passed `--data-dir ./x` straight through; with a relative
    // root, listMarkdown('inbox/.processing') threw an escape error mid-sweep.
    const relative = path.relative(process.cwd(), dataDir);
    const vault = createVault({ dataDir: relative });
    expect(() => vault.listMarkdown("inbox/.processing")).not.toThrow();
    expect(vault.listMarkdown("inbox/.processing")).toEqual([]);
  });
});

describe("vault file I/O", () => {
  it("round-trips a document through write → read", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("people/anna.md", doc("anna"));
    expect(vault.readDocument("people/anna.md")).toEqual(doc("anna"));
  });

  it("creates nested parent folders on write", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("references/deploy/notes.md", doc("notes"));
    expect(fs.existsSync(path.join(vault.root, "references/deploy/notes.md"))).toBe(true);
  });

  it("lists markdown recursively as sorted, posix-relative paths and ignores non-markdown", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("people/anna.md", doc("anna"));
    vault.writeDocument("projects/x.md", doc("x"));
    fs.writeFileSync(path.join(vault.root, "people", "notes.txt"), "ignored");
    expect(vault.listMarkdown()).toEqual(["people/anna.md", "projects/x.md"]);
  });

  it("scopes listMarkdown to a subdirectory and returns [] for a missing one", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("people/anna.md", doc("anna"));
    vault.writeDocument("projects/x.md", doc("x"));
    expect(vault.listMarkdown("people")).toEqual(["people/anna.md"]);
    expect(vault.listMarkdown("nope")).toEqual([]);
  });

  it("listFiles lists ALL files recursively (any extension), sorted + posix-relative", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("people/anna.md", doc("anna"));
    fs.writeFileSync(path.join(vault.root, "people", "photo.png"), "bytes");
    expect(vault.listFiles("people")).toEqual(["people/anna.md", "people/photo.png"]);
    expect(vault.listFiles("nope")).toEqual([]);
  });

  it("moves a file (the archive=move primitive)", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("people/anna.md", doc("anna"));
    vault.moveFile("people/anna.md", "archive/anna.md");
    expect(vault.exists("people/anna.md")).toBe(false);
    expect(vault.readDocument("archive/anna.md").frontmatter.id).toBe("anna");
  });

  it("removeFile hard-deletes (the admin/purge exception) and is idempotent", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("people/anna.md", doc("anna"));
    vault.removeFile("people/anna.md");
    expect(vault.exists("people/anna.md")).toBe(false);
    expect(() => vault.removeFile("people/anna.md")).not.toThrow();
  });

  it("tryReadDocument returns null for a missing file; readDocument throws a teaching error", () => {
    const vault = createVault({ dataDir });
    expect(vault.tryReadDocument("ghost.md")).toBeNull();
    expect(() => vault.readDocument("ghost.md")).toThrow(/ghost\.md/);
  });

  it("refuses a path that escapes the vault root", () => {
    const vault = createVault({ dataDir });
    expect(() => vault.writeDocument("../escape.md", doc("x"))).toThrow(/escape/i);
    expect(() => vault.readDocument("../../etc/passwd")).toThrow(/escape/i);
  });
});

describe("vault raw text I/O", () => {
  it("round-trips raw markdown verbatim through writeText → readText", () => {
    const vault = createVault({ dataDir });
    const content = "---\nid: x\n---\n\nbody with [[wikilink]].\n";
    vault.writeText("notes/x.md", content);
    expect(vault.readText("notes/x.md")).toBe(content);
  });

  it("tryReadText returns null for a missing file; readText throws a teaching error", () => {
    const vault = createVault({ dataDir });
    expect(vault.tryReadText("ghost.md")).toBeNull();
    expect(() => vault.readText("ghost.md")).toThrow(/no document at 'ghost\.md'/);
  });

  it("applies the path-escape guard to the raw methods", () => {
    const vault = createVault({ dataDir });
    expect(() => vault.writeText("../escape.md", "x")).toThrow(/escape/i);
    expect(() => vault.readText("../../etc/passwd")).toThrow(/escape/i);
  });
});
