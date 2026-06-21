// Wikilink parse + surgical-rename tests (spec 035 §F1/§F12 — Phase 1).
//
// Link integrity is a Phase-1 checkpoint: a rename must rewrite *every*
// wikilink form and leave the rest of the document byte-identical (minimal
// git diffs — no full re-stringify). These tests pin the four Obsidian
// forms — [[x]] / [[x|alias]] / [[x#heading]] / ![[embed]] — plus the
// heading+alias combo, and that a rename touches only the matching targets.

import { parseWikilinks, renameWikilinkTarget } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("parseWikilinks", () => {
  it("extracts a plain link with its source span", () => {
    const md = "see [[elaine]] now";
    const links = parseWikilinks(md);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      embed: false,
      target: "elaine",
      heading: null,
      alias: null,
      raw: "[[elaine]]",
    });
    expect(md.slice(links[0]!.start, links[0]!.end)).toBe("[[elaine]]");
  });

  it("parses every wikilink form", () => {
    const md = "[[plain]] [[t|Display]] [[doc#Heading]] ![[embedded]] [[d#H|A]]";
    const links = parseWikilinks(md);
    expect(
      links.map((l) => ({ embed: l.embed, target: l.target, heading: l.heading, alias: l.alias })),
    ).toEqual([
      { embed: false, target: "plain", heading: null, alias: null },
      { embed: false, target: "t", heading: null, alias: "Display" },
      { embed: false, target: "doc", heading: "Heading", alias: null },
      { embed: true, target: "embedded", heading: null, alias: null },
      { embed: false, target: "d", heading: "H", alias: "A" },
    ]);
  });

  it("ignores non-wikilink brackets and markdown links", () => {
    expect(parseWikilinks("a [single] b [text](http://x) c [[]] d")).toEqual([]);
  });

  it("tolerates targets containing spaces and slashes", () => {
    const links = parseWikilinks("[[people/Elaine Threepwood]]");
    expect(links[0]).toMatchObject({ target: "people/Elaine Threepwood" });
  });
});

describe("renameWikilinkTarget", () => {
  it("rewrites every form that points at the renamed target, preserving alias/heading/embed", () => {
    const md = "[[elaine]] [[elaine|Elaine]] [[elaine#Bio]] ![[elaine]] [[elaine#Bio|Elaine]]";
    expect(renameWikilinkTarget(md, "elaine", "elaine-threepwood")).toBe(
      "[[elaine-threepwood]] [[elaine-threepwood|Elaine]] [[elaine-threepwood#Bio]] ![[elaine-threepwood]] [[elaine-threepwood#Bio|Elaine]]",
    );
  });

  it("leaves non-matching links and surrounding prose byte-identical", () => {
    const md = "# Notes\n\n[[elaine]] knows [[bob]]. Code: `[[elaine]]` stays prose.\n";
    const out = renameWikilinkTarget(md, "elaine", "elaine-2");
    // bob untouched; the prose/structure unchanged except the two `elaine` targets.
    expect(out).toBe("# Notes\n\n[[elaine-2]] knows [[bob]]. Code: `[[elaine-2]]` stays prose.\n");
  });

  it("is a no-op when the target does not occur", () => {
    const md = "[[bob]] and [[carol|C]]";
    expect(renameWikilinkTarget(md, "elaine", "elaine-2")).toBe(md);
  });

  it("matches the target exactly (not a substring or prefix)", () => {
    const md = "[[elaine]] [[elainebel]] [[elaine-lee]]";
    expect(renameWikilinkTarget(md, "elaine", "ZZ")).toBe("[[ZZ]] [[elainebel]] [[elaine-lee]]");
  });
});
