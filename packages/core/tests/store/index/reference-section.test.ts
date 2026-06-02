// Reference-section extraction tests (plan 036 Phase 3 / spec 035 §F3 —
// search_references returns "pointer + relevant section"). Given a reference
// doc's markdown and a query, return the heading-delimited section most
// relevant to the query so the caller surfaces the matched section, not the
// whole (potentially huge) document.

import { extractRelevantSection } from "@librarian/core";
import { describe, expect, it } from "vitest";

const doc = [
  "Intro preamble about the household.",
  "",
  "## Piano",
  "The grand piano needs tuning twice a year and regular voicing.",
  "",
  "## Garden",
  "The roses are pruned in winter and fed in spring.",
].join("\n");

describe("extractRelevantSection", () => {
  it("returns the heading section most relevant to the query", () => {
    const section = extractRelevantSection(doc, "piano tuning");
    expect(section).toContain("## Piano");
    expect(section).toContain("needs tuning");
    expect(section).not.toContain("roses"); // the Garden section is excluded
  });

  it("picks a different section for a different query", () => {
    const section = extractRelevantSection(doc, "roses pruning");
    expect(section).toContain("## Garden");
    expect(section).not.toContain("grand piano");
  });

  it("treats the preamble before the first heading as its own section", () => {
    const section = extractRelevantSection(doc, "household preamble");
    expect(section).toContain("Intro preamble");
    expect(section).not.toContain("## Piano");
  });

  it("returns the whole text when there are no headings", () => {
    const flat = "Just a flat note with no headings at all about sailing boats.";
    expect(extractRelevantSection(flat, "sailing")).toBe(flat);
  });

  it("falls back to the first section when nothing matches the query", () => {
    const section = extractRelevantSection(doc, "zzzznotaword");
    expect(section).toContain("Intro preamble");
  });

  it("matches a keyword even when it ends a sentence (trailing punctuation)", () => {
    const d = "## Alpha\nShort note here.\n\n## Beta\nEverything you need about tuning.";
    const section = extractRelevantSection(d, "tuning");
    expect(section).toContain("## Beta"); // "tuning." still matches "tuning"
  });

  it("prefers the section covering the most query terms, not the longest", () => {
    const d = [
      "## Background",
      "piano piano piano piano history lore saga epic tale of the instrument",
      "",
      "## Tuning Procedure",
      "piano tuning steps",
    ].join("\n");
    const section = extractRelevantSection(d, "piano tuning");
    expect(section).toContain("## Tuning Procedure"); // 2 distinct terms beats volume
  });

  it("does not treat a heading inside a fenced code block as a section break", () => {
    const d = [
      "## Setup",
      "run the installer",
      "```bash",
      "# configure the database now",
      "createdb mydb",
      "```",
      "## Usage",
      "start the app",
    ].join("\n");
    const section = extractRelevantSection(d, "configure database");
    expect(section).toContain("## Setup"); // the fenced `# configure...` did not split
  });

  it("normalizes CRLF line endings out of the returned section", () => {
    const d = "## A\r\nfirst about cats\r\n\r\n## B\r\nsecond about dogs";
    const section = extractRelevantSection(d, "dogs");
    expect(section).toContain("## B");
    expect(section).not.toContain("\r");
  });

  it("returns the first section for an all-stopword query", () => {
    expect(extractRelevantSection(doc, "the and for")).toContain("Intro preamble");
  });
});
