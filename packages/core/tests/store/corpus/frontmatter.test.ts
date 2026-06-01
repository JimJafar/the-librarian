// Corpus frontmatter round-trip tests (spec 035 §F1 — Phase 1 checkpoint).
//
// The markdown is the source of truth, so frontmatter parse/serialize must
// round-trip byte-for-byte (minimal git diffs) and survive hand edits in
// Obsidian/the dashboard. These tests pin:
//   - the minimal D16 schema (id, aliases, tags, category, created, updated),
//   - byte-stable serialize(parse(x)) === x,
//   - value-stable parse(serialize(doc)) deep-equals doc,
//   - timestamps stay strings even when YAML would coerce them to Date,
//   - teaching errors that name the offending field.

import { type CorpusDocument, parseDocument, serializeDocument } from "@librarian/core";
import { describe, expect, it } from "vitest";

const sampleDoc: CorpusDocument = {
  frontmatter: {
    id: "anna-sangwine",
    aliases: ["Anna", "Anna S."],
    tags: ["family", "people"],
    category: "people",
    created: "2026-05-31T09:00:00.000Z",
    updated: "2026-06-01T10:30:00.000Z",
  },
  body: "# Anna\n\nAnna is Jim's wife. See also [[sophie-sangwine]].",
};

// The canonical on-disk form `serializeDocument` is expected to emit.
const canonical = `---
id: "anna-sangwine"
aliases:
  - "Anna"
  - "Anna S."
tags:
  - "family"
  - "people"
category: "people"
created: "2026-05-31T09:00:00.000Z"
updated: "2026-06-01T10:30:00.000Z"
---

# Anna

Anna is Jim's wife. See also [[sophie-sangwine]].
`;

describe("corpus frontmatter", () => {
  it("serializes a document to the canonical, deterministic form", () => {
    expect(serializeDocument(sampleDoc)).toBe(canonical);
  });

  it("parses the canonical form back into the document", () => {
    expect(parseDocument(canonical)).toEqual(sampleDoc);
  });

  it("round-trips byte-for-byte: serialize(parse(x)) === x", () => {
    expect(serializeDocument(parseDocument(canonical))).toBe(canonical);
  });

  it("round-trips by value: parse(serialize(doc)) deep-equals doc", () => {
    expect(parseDocument(serializeDocument(sampleDoc))).toEqual(sampleDoc);
  });

  it("defaults aliases and tags to empty arrays when absent", () => {
    const raw = `---
id: "pnpm-usage"
category: "preferences"
created: "2026-05-31T09:00:00.000Z"
updated: "2026-05-31T09:00:00.000Z"
---

Always use pnpm, never npm.
`;
    const doc = parseDocument(raw);
    expect(doc.frontmatter.aliases).toEqual([]);
    expect(doc.frontmatter.tags).toEqual([]);
    expect(doc.body).toBe("Always use pnpm, never npm.");
  });

  it("keeps timestamps as strings even when YAML leaves them unquoted (Obsidian edits)", () => {
    const raw = `---
id: "x"
category: "lessons"
created: 2026-05-31T09:00:00.000Z
updated: 2026-05-31T09:00:00.000Z
---

body
`;
    const doc = parseDocument(raw);
    expect(typeof doc.frontmatter.created).toBe("string");
    expect(doc.frontmatter.created).toBe("2026-05-31T09:00:00.000Z");
  });

  it("preserves a body that contains every wikilink form untouched", () => {
    const body = "See [[x]], [[y|Why]], [[z#Heading]], and ![[embed]].";
    const doc: CorpusDocument = { ...sampleDoc, body };
    expect(parseDocument(serializeDocument(doc)).body).toBe(body);
  });

  it("round-trips an empty body", () => {
    const doc: CorpusDocument = { ...sampleDoc, body: "" };
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });

  it("rejects a missing id with a teaching error that names the field", () => {
    const raw = `---
category: "people"
created: "2026-05-31T09:00:00.000Z"
updated: "2026-05-31T09:00:00.000Z"
---

body
`;
    expect(() => parseDocument(raw)).toThrow(/id/);
  });

  it("rejects a missing category with a teaching error that names the field", () => {
    const raw = `---
id: "x"
created: "2026-05-31T09:00:00.000Z"
updated: "2026-05-31T09:00:00.000Z"
---

body
`;
    expect(() => parseDocument(raw)).toThrow(/category/);
  });

  it("rejects a non-ISO timestamp with a teaching error", () => {
    const raw = `---
id: "x"
category: "people"
created: "2026-13-99"
updated: "2026-05-31T09:00:00.000Z"
---

body
`;
    expect(() => parseDocument(raw)).toThrow(/created/);
  });
});
