// Backlink-aware recall tests (plan 036 Phase 3 / spec 035 §F3, S2 — the
// "Anna problem"). recallFromIndex combines the hybrid index (keyword+vector)
// with the link graph: direct query matches PLUS their backlink neighbours
// (both directions), so a fact filed under either entity is retrievable from
// the other and the bundle is self-contained (no ID-chasing).

import {
  buildHybridIndex,
  buildLinkGraph,
  createHashEmbedder,
  recallFromIndex,
} from "@librarian/core";
import { beforeEach, describe, expect, it } from "vitest";

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

  it("bounds the result set to the limit", async () => {
    const hits = await recallFromIndex(deps, "piano matriarch bicycles", { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
