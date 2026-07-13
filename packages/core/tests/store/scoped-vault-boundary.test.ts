// Shelf-boundary guard on the SCOPED vault view (spec 062 review G2 + its follow-up).
//
// `scopeVault(vault, prefix)` promises that "a scoped handle can never cross into another shelf's
// subtree": every shelf-relative path it is handed is resolved against `<root>/<prefix>` and refused
// when it escapes. The read/write/move/exists accessors route through that guard (`toFull`); LIST did
// not — it concatenated `prefix + subdir` raw, so `listMarkdown("../../team/references")` on a
// `members/x/` handle returned a SIBLING shelf's listing (the underlying vault's own `within()` only
// stops an escape from the WHOLE vault, and `members/x/../../team/…` stays inside the repo). Not
// externally reachable today — every caller passes a hardcoded subdir, and `scopeVault` is not on the
// extension entrypoint — but the invariant is defense-in-depth and must hold at the seam, not by the
// grace of its current callers.
//
// `scopeVault` is deliberately NOT exported from the package entrypoint (it is a store-internal seam,
// not plugin surface), so this suite imports the built artifact directly — the same pattern the
// mcp-server suites use for internals (`../dist/...`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVault, scopeVault } from "../../dist/store/corpus/vault.js";

const dataDirs: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A vault with two disjoint shelves seeded: `members/x/` (ours) and `team/` (the sibling). */
function twoShelfVault(): { vaultPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-scopevault-"));
  dataDirs.push(dir);
  const vaultPath = path.join(dir, "vault");
  const vault = createVault({ vaultPath });
  vault.writeText("members/x/references/mine.md", "# mine\n");
  vault.writeText("team/references/secret.md", "# the sibling shelf's document\n");
  return { vaultPath };
}

describe("scopeVault — the shelf boundary holds on LIST too", () => {
  it("refuses a `../` subdir instead of listing a SIBLING shelf's subtree", () => {
    const { vaultPath } = twoShelfVault();
    const scoped = scopeVault(createVault({ vaultPath }), "members/x/");

    // Pre-fix this returned the sibling shelf's listing (["../../team/references/secret.md"]-ish),
    // silently crossing the shelf boundary the guard's own comment says is impossible.
    expect(() => scoped.listMarkdown("../../team/references")).toThrow(/escapes the shelf prefix/);
    expect(() => scoped.listFiles("../../team/references")).toThrow(/escapes the shelf prefix/);
    // A bare `..` (the shelf's parent) is an escape too.
    expect(() => scoped.listMarkdown("..")).toThrow(/escapes the shelf prefix/);
  });

  it("still lists the shelf's own subtree (the guard refuses escapes, not legitimate subdirs)", () => {
    const { vaultPath } = twoShelfVault();
    const scoped = scopeVault(createVault({ vaultPath }), "members/x/");

    // Shelf-relative in, shelf-relative out — the sibling's file never appears.
    expect(scoped.listMarkdown("references")).toEqual(["references/mine.md"]);
    expect(scoped.listMarkdown()).toEqual(["references/mine.md"]); // the whole shelf (no subdir)
    expect(scoped.listFiles("references")).toEqual(["references/mine.md"]);
  });
});
