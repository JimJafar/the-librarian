// Keyword index tests (plan 036 Phase 3 / spec 035 §F2). A deterministic,
// dependency-free inverted index over the corpus (reusing the shared
// tokenizer): term → {docId → term-frequency}; search scores by summed tf of
// the matching query terms. Rebuildable from the markdown (disposable index).

import { buildKeywordIndex } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("buildKeywordIndex", () => {
  it("returns docs that match the query, ranked by term frequency", () => {
    const index = buildKeywordIndex([
      { id: "pnpm", text: "use pnpm for the monorepo; pnpm pnpm pnpm" },
      { id: "npm", text: "npm is fine too" },
      { id: "cal", text: "calendar tuesdays" },
    ]);
    const hits = index.search("pnpm");
    expect(hits.map((h) => h.id)).toEqual(["pnpm"]);
    expect(hits[0]!.score).toBe(4); // four occurrences of "pnpm"
  });

  it("sums tf across multiple query terms; more-relevant docs rank higher", () => {
    const index = buildKeywordIndex([
      { id: "a", text: "deploy deploy command notes" },
      { id: "b", text: "deploy once" },
    ]);
    const hits = index.search("deploy command");
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]); // a: 2+1=3, b: 1
  });

  it("excludes non-matching docs and respects the limit", () => {
    const index = buildKeywordIndex([
      { id: "a", text: "alpha beta" },
      { id: "b", text: "alpha gamma" },
      { id: "c", text: "delta" },
    ]);
    expect(
      index
        .search("alpha")
        .map((h) => h.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(index.search("alpha", 1)).toHaveLength(1);
  });

  it("breaks score ties by id for stable ordering", () => {
    const index = buildKeywordIndex([
      { id: "zeta", text: "shared" },
      { id: "alpha", text: "shared" },
    ]);
    expect(index.search("shared").map((h) => h.id)).toEqual(["alpha", "zeta"]);
  });

  it("returns [] for a query with no indexable terms", () => {
    const index = buildKeywordIndex([{ id: "a", text: "alpha" }]);
    expect(index.search("")).toEqual([]);
    expect(index.search("a the and")).toEqual([]); // too-short + stopwords
  });
});
