// Namespaced index tests (plan 036 Phase 3 / spec 035 §F2, F4 — Tier 0/Tier 1
// isolation). corpus docs (Tier 1) and references docs (Tier 0) live in
// SEPARATE indexes: recall() only ever sees the corpus, search_references()
// only ever sees the references. That makes S8 (a big reference doc must not
// change Tier-1 recall) a structural guarantee, not a filter.

import { createHashEmbedder, createNamespacedIndex } from "@librarian/core";
import { describe, expect, it } from "vitest";

const corpus = [
  {
    id: "sophie",
    text: "Sophie is [[anna]] daughter and loves playing piano music",
    namespace: "corpus" as const,
  },
  {
    id: "anna",
    text: "Anna is the family matriarch and head of household",
    namespace: "corpus" as const,
  },
];
const bigReference = {
  id: "piano-manual",
  text: "piano tuning maintenance guide covering grand piano regulation voicing and piano hammer care",
  namespace: "references" as const,
};

describe("createNamespacedIndex", () => {
  it("S8: adding a reference doc does not change Tier-1 recall", async () => {
    const withoutRef = await createNamespacedIndex(corpus, createHashEmbedder());
    const withRef = await createNamespacedIndex([...corpus, bigReference], createHashEmbedder());
    const before = (await withoutRef.recall("piano")).map((h) => h.id);
    const after = (await withRef.recall("piano")).map((h) => h.id);
    expect(after).toEqual(before); // references are invisible to Tier-1 recall
  });

  it("isolates the namespaces: recall is Tier-1 only, search_references is Tier-0 only", async () => {
    const index = await createNamespacedIndex([...corpus, bigReference], createHashEmbedder());
    const recalled = (await index.recall("piano")).map((h) => h.id);
    expect(recalled).toContain("sophie"); // corpus hit
    expect(recalled).not.toContain("piano-manual"); // reference excluded from recall

    const refs = (await index.searchReferences("piano")).map((h) => h.id);
    expect(refs).toContain("piano-manual"); // reference hit
    expect(refs).not.toContain("sophie"); // corpus excluded from references
  });

  it("search_references returns the matched section, not just a pointer (F3)", async () => {
    const sectioned = {
      id: "manual",
      text: "## Tuning\nthe grand piano needs tuning twice a year\n\n## Cleaning\nwipe the keys gently",
      namespace: "references" as const,
    };
    const index = await createNamespacedIndex([sectioned], createHashEmbedder());
    const [hit] = await index.searchReferences("tuning");
    expect(hit?.section).toContain("## Tuning");
    expect(hit?.section).not.toContain("## Cleaning");
  });

  it("recall still expands backlinks within the corpus (Anna problem through the wrapper)", async () => {
    const index = await createNamespacedIndex([...corpus, bigReference], createHashEmbedder());
    const ids = (await index.recall("matriarch")).map((h) => h.id);
    expect(ids).toContain("anna"); // direct
    expect(ids).toContain("sophie"); // inbound backlink
  });

  it("S8 (linked): a corpus doc linking to a reference does not pull it into recall", async () => {
    // the dangerous case — a corpus wikilink straight at a reference id must
    // NOT backlink-expand the reference into Tier-1 recall.
    const linkedCorpus = [
      {
        id: "note",
        text: "Project alpha relies on the [[piano-manual]] for tuning details",
        namespace: "corpus" as const,
      },
    ];
    const index = await createNamespacedIndex(
      [...linkedCorpus, bigReference],
      createHashEmbedder(),
    );
    const recalled = (await index.recall("project alpha")).map((h) => h.id);
    expect(recalled).toContain("note");
    expect(recalled).not.toContain("piano-manual"); // out-of-namespace link is not expanded
  });

  it("returns no references when none are indexed", async () => {
    const index = await createNamespacedIndex(corpus, createHashEmbedder());
    expect(await index.searchReferences("piano")).toEqual([]);
  });

  it("returns no recall hits when the corpus is empty", async () => {
    const index = await createNamespacedIndex([bigReference], createHashEmbedder());
    expect(await index.recall("piano")).toEqual([]);
  });
});
