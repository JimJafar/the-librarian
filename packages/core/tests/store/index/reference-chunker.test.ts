// Reference chunker (rethink T24 / spec §9 D5) — splits a reference doc by
// heading structure first, then size-bounds oversized sections (with modest
// overlap so a fact straddling a cut is still embedded whole somewhere). Each
// chunk carries a heading-breadcrumb anchor + its char range in the source, so
// search hits can point INTO a large document. This replaces the old
// whole-doc embedding truncation (only the first ~2K tokens searchable).

import { chunkReference } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("chunkReference", () => {
  it("splits on headings, one chunk per small section, with breadcrumb anchors", () => {
    const doc = [
      "# Manual",
      "intro text",
      "## Tuning",
      "tune twice a year",
      "## Cleaning",
      "wipe the keys",
    ].join("\n");
    const chunks = chunkReference(doc);
    expect(chunks.map((c) => c.anchor)).toEqual(["Manual", "Manual > Tuning", "Manual > Cleaning"]);
    expect(chunks[1]?.text).toContain("tune twice a year");
    expect(chunks[1]?.text).not.toContain("wipe the keys");
  });

  it("keeps content before the first heading as an anchorless preamble chunk", () => {
    const chunks = chunkReference("preamble line\n\n# First\nbody");
    expect(chunks[0]?.anchor).toBe("");
    expect(chunks[0]?.text).toContain("preamble line");
    expect(chunks[1]?.anchor).toBe("First");
  });

  it("pops siblings off the breadcrumb when a same-or-higher heading level appears", () => {
    const doc = ["# Top", "## A", "a body", "### A1", "a1 body", "## B", "b body"].join("\n");
    const chunks = chunkReference(doc);
    expect(chunks.map((c) => c.anchor)).toEqual(["Top", "Top > A", "Top > A > A1", "Top > B"]);
  });

  it("splits an oversized section into size-bounded chunks with overlap, same anchor", () => {
    const body = Array.from({ length: 80 }, (_, i) => `line ${i} of the long section`).join("\n");
    const doc = `## Long\n${body}`;
    const chunks = chunkReference(doc, { maxChunkChars: 400, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400);
      expect(chunk.anchor).toBe("Long");
    }
    // consecutive chunks overlap (modest, never gap) and always advance
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBeLessThan(chunks[i - 1]!.end); // overlap
      expect(chunks[i]!.start).toBeGreaterThan(chunks[i - 1]!.start); // progress
    }
    // nothing past the last chunk is lost
    expect(chunks[chunks.length - 1]!.end).toBe(doc.length);
  });

  it("char ranges slice back to exactly the chunk text", () => {
    const body = Array.from({ length: 60 }, (_, i) => `fact number ${i}`).join("\n");
    const doc = `intro\n## Section\n${body}\n## Next\ntail`;
    for (const chunk of chunkReference(doc, { maxChunkChars: 300, overlapChars: 50 })) {
      expect(doc.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });

  it("degenerate no-headings doc still chunks (size-bound windows, empty anchor)", () => {
    const doc = Array.from({ length: 100 }, (_, i) => `plain line ${i}`).join("\n");
    const chunks = chunkReference(doc, { maxChunkChars: 300, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.anchor).toBe("");
    expect(chunks[chunks.length - 1]!.end).toBe(doc.length);
  });

  it("a # line inside a fenced code block is not a heading", () => {
    const doc = ["# Real", "```sh", "# just a comment", "```", "after the fence"].join("\n");
    const chunks = chunkReference(doc);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.anchor).toBe("Real");
    expect(chunks[0]?.text).toContain("after the fence");
  });

  it("a small doc is a single chunk covering the whole document", () => {
    const chunks = chunkReference("# Tiny\njust one line");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[0]?.end).toBe("# Tiny\njust one line".length);
  });

  it("an empty/whitespace-only doc produces no chunks", () => {
    expect(chunkReference("")).toEqual([]);
    expect(chunkReference("  \n\n  ")).toEqual([]);
  });
});
