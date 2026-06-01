// Backlink-aware recall tests (plan 036 Phase 3 / spec 035 §F3, S2 — the
// "Anna problem"). recallFromIndex combines the hybrid index (keyword+vector)
// with the link graph: direct query matches PLUS their backlink neighbours
// (both directions), so a fact filed under either entity is retrievable from
// the other and the bundle is self-contained (no ID-chasing).

import {
  type Embedder,
  buildHybridIndex,
  buildLinkGraph,
  createHashEmbedder,
  recallFromIndex,
} from "@librarian/core";
import { beforeEach, describe, expect, it } from "vitest";

// Keyword-only embedder: a zero vector gives every doc cosine NaN, so the
// vector signal contributes nothing and recall falls to pure keyword + graph.
// Structural tests use this to isolate graph-expansion behaviour from the hash
// embedder's lexical bucket-collision noise (it is lexical, not semantic).
const keywordOnly: Embedder = { embed: async () => [0] };

// NB: queried words are kept mid-sentence (no trailing punctuation). The
// shared tokenizer retains `. / - _` as in-token chars (for path tokens like
// `file.ts`), so a sentence-final "piano." would index as the token "piano."
// and never match a "piano" query — a pre-existing quirk, noted for review.
const docs = [
  { id: "sophie", text: "Sophie is [[anna]] daughter and loves playing piano music" },
  { id: "anna", text: "Anna is the family matriarch and head of household" },
  { id: "bob", text: "Bob repairs bicycles in his garage workshop" },
];

let deps: {
  hybrid: Awaited<ReturnType<typeof buildHybridIndex>>;
  linkGraph: ReturnType<typeof buildLinkGraph>;
};

beforeEach(async () => {
  deps = {
    hybrid: await buildHybridIndex(docs, createHashEmbedder()),
    linkGraph: buildLinkGraph(docs.map((d) => ({ id: d.id, body: d.text }))),
  };
});

describe("recallFromIndex (backlink-aware)", () => {
  it("returns a direct match AND pulls in its outbound neighbour", async () => {
    // "piano" matches sophie; sophie → [[anna]] (outbound) is pulled in.
    const hits = await recallFromIndex(deps, "piano");
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get("sophie")?.matchedDirectly).toBe(true);
    expect(byId.get("anna")?.matchedDirectly).toBe(false); // pulled in via the link
    expect(byId.has("bob")).toBe(false);
  });

  it("Anna problem: querying the matriarch also surfaces sophie (inbound backlink)", async () => {
    const hits = await recallFromIndex(deps, "matriarch");
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get("anna")?.matchedDirectly).toBe(true);
    expect(byId.get("sophie")?.matchedDirectly).toBe(false); // backlink from anna
  });

  it("direct matches rank above backlink-expanded neighbours", async () => {
    const hits = await recallFromIndex(deps, "piano");
    const annaRank = hits.findIndex((h) => h.id === "anna");
    const sophieRank = hits.findIndex((h) => h.id === "sophie");
    expect(sophieRank).toBeLessThan(annaRank); // direct (sophie) before neighbour (anna)
  });

  it("expandBacklinks: false returns only direct matches", async () => {
    const hits = await recallFromIndex(deps, "piano", { expandBacklinks: false });
    expect(hits.map((h) => h.id)).toEqual(["sophie"]);
  });

  it("bounds the result set to the limit, keeping direct matches over neighbours", async () => {
    // all three docs match directly; with limit < direct-count only direct
    // matches survive (direct-first), never a decayed neighbour.
    const hits = await recallFromIndex(deps, "piano matriarch bicycles", { limit: 2 });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.matchedDirectly)).toBe(true);
  });

  it("expands a single hop only — a neighbour's neighbour is not pulled in", async () => {
    const chain = [
      { id: "alpha", text: "alpha mentions [[bravo]] and discusses telescopes" },
      { id: "bravo", text: "bravo mentions [[charlie]] about gardening" },
      { id: "charlie", text: "charlie writes poetry" },
    ];
    const chainDeps = {
      hybrid: await buildHybridIndex(chain, keywordOnly),
      linkGraph: buildLinkGraph(chain.map((d) => ({ id: d.id, body: d.text }))),
    };
    const hits = await recallFromIndex(chainDeps, "telescopes");
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("alpha"); // direct
    expect(ids).toContain("bravo"); // one hop
    expect(ids).not.toContain("charlie"); // two hops — excluded
  });

  it("breaks score ties deterministically by id (two neighbours of one seed)", async () => {
    // hub links both xray and yankee → both neighbours share the identical
    // decayed score, so the id tie-break must order xray before yankee.
    const star = [
      { id: "hub", text: "hub references [[xray]] and [[yankee]] about astronomy" },
      { id: "xray", text: "xray holds some content" },
      { id: "yankee", text: "yankee holds some content" },
    ];
    const starDeps = {
      hybrid: await buildHybridIndex(star, keywordOnly),
      linkGraph: buildLinkGraph(star.map((d) => ({ id: d.id, body: d.text }))),
    };
    const hits = await recallFromIndex(starDeps, "astronomy");
    const neighbours = hits.filter((h) => !h.matchedDirectly).map((h) => h.id);
    expect(neighbours).toEqual(["xray", "yankee"]);
  });
});
