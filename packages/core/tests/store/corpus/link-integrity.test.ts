// Vault-wide link-integrity tests (spec 035 §F12 — Phase 1 checkpoint:
// "rename rewrites every wikilink form").
//
// relinkVault rewrites a renamed target across *every* document in the
// vault (all wikilink forms), writes back only the docs that changed, and
// returns those paths — leaving non-referencing docs untouched. The file
// move (vault.moveFile) and the commit (git.commitAll) are the caller's
// separate steps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CorpusDocument, createVault, relinkVault } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-relink-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const doc = (id: string, body: string): CorpusDocument => ({
  frontmatter: {
    id,
    aliases: [],
    tags: [],
    category: "people",
    created: "2026-06-01T00:00:00.000Z",
    updated: "2026-06-01T00:00:00.000Z",
  },
  body,
});

describe("relinkVault", () => {
  it("rewrites every wikilink form pointing at the renamed target, across docs", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("people/elaine.md", doc("elaine", "I am [[elaine]] (self)."));
    vault.writeDocument(
      "people/sophie.md",
      doc("sophie", "[[elaine|Mum]] and [[elaine#Bio]] and ![[elaine]]."),
    );
    vault.writeDocument("people/bob.md", doc("bob", "knows [[carol]] only."));

    const changed = relinkVault(vault, "elaine", "elaine-threepwood");

    expect(changed).toEqual(["people/elaine.md", "people/sophie.md"]);
    expect(vault.readDocument("people/elaine.md").body).toBe("I am [[elaine-threepwood]] (self).");
    expect(vault.readDocument("people/sophie.md").body).toBe(
      "[[elaine-threepwood|Mum]] and [[elaine-threepwood#Bio]] and ![[elaine-threepwood]].",
    );
    // The doc that didn't reference `elaine` is untouched.
    expect(vault.readDocument("people/bob.md").body).toBe("knows [[carol]] only.");
  });

  it("is a no-op (returns []) when no document references the target", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("a.md", doc("a", "[[b]] and [[c]]"));
    expect(relinkVault(vault, "elaine", "elaine-2")).toEqual([]);
    expect(vault.readDocument("a.md").body).toBe("[[b]] and [[c]]");
  });

  it("relinks documents anywhere in the vault tree, including archive/", () => {
    const vault = createVault({ dataDir });
    vault.writeDocument("archive/old.md", doc("old", "still mentions [[elaine]]."));
    expect(relinkVault(vault, "elaine", "elaine-threepwood")).toEqual(["archive/old.md"]);
    expect(vault.readDocument("archive/old.md").body).toBe("still mentions [[elaine-threepwood]].");
  });
});
