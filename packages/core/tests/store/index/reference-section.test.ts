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
});
