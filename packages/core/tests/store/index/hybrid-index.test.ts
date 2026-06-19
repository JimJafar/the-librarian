// Hybrid index tests (plan 036 Phase 3 / spec 035 §F2). Fuses the keyword +
// vector signals with Reciprocal Rank Fusion (RRF) — robust + normalization-
// free. The embedder is pluggable + async; tests use the deterministic
// zero-dep hash embedder (also a usable fallback when no model is configured).

import { type Embedder, buildHybridIndex, createHashEmbedder } from "@librarian/core";
import { describe, expect, it } from "vitest";

const docs = [
  { id: "pnpm", text: "use pnpm for the monorepo workspace" },
  { id: "npm", text: "npm registry publishing notes" },
  { id: "cal", text: "calendar tuesdays and thursdays" },
];

// A zero-vector embedder: cosine is 0 for every doc, so the vector signal drops
// out and ranking is keyword (BM25) + phrase only — isolates the phrase boost.
const keywordOnly: Embedder = { embed: async () => [0] };

describe("createHashEmbedder", () => {
  it("is deterministic and gives shared-token texts a positive cosine", async () => {
    const e = createHashEmbedder();
    const a = await e.embed("pnpm workspace");
    const b = await e.embed("pnpm workspace");
    expect(a).toEqual(b); // deterministic
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("buildHybridIndex", () => {
  it("ranks the matching doc first by fusing keyword + vector", async () => {
    const index = await buildHybridIndex(docs, createHashEmbedder());
    const hits = await index.search("pnpm monorepo");
    expect(hits[0]!.id).toBe("pnpm");
  });

  it("excludes docs that match neither signal", async () => {
    const index = await buildHybridIndex(docs, createHashEmbedder());
    const hits = await index.search("pnpm");
    expect(hits.map((h) => h.id)).not.toContain("cal");
  });

  it("respects the limit", async () => {
    const index = await buildHybridIndex(docs, createHashEmbedder());
    expect((await index.search("notes registry calendar", 1)).length).toBeLessThanOrEqual(1);
  });

  it("returns [] for a query with no signal", async () => {
    const index = await buildHybridIndex(docs, createHashEmbedder());
    expect(await index.search("zzzznotaword")).toEqual([]);
  });

  it("works with an injected custom embedder (pluggable)", async () => {
    // A trivial 1-dim embedder: vector magnitude = token count → all texts
    // align (cosine 1), so ranking falls to the keyword signal.
    const oneDim: Embedder = {
      embed: async (text) => [text.split(/\s+/).filter(Boolean).length || 0.0001],
    };
    const index = await buildHybridIndex(docs, oneDim);
    const hits = await index.search("calendar");
    expect(hits[0]!.id).toBe("cal");
  });

  it("embeds documents with embed() and the query with embedQuery() when provided", async () => {
    // an asymmetric embedder: records the role each text was embedded under.
    const hash = createHashEmbedder();
    const roles: string[] = [];
    const asymmetric: Embedder = {
      embed: (text) => {
        roles.push(`doc:${text}`);
        return hash.embed(text);
      },
      embedQuery: (text) => {
        roles.push(`query:${text}`);
        return hash.embed(text);
      },
    };
    const index = await buildHybridIndex([{ id: "pnpm", text: "pnpm workspace" }], asymmetric);
    await index.search("pnpm");
    expect(roles).toContain("doc:pnpm workspace"); // document embedded via embed()
    expect(roles).toContain("query:pnpm"); // query embedded via embedQuery()
    expect(roles).not.toContain("doc:pnpm"); // the query did NOT go through embed()
  });

  it("boosts a doc with the exact query phrase over one with the terms scattered", async () => {
    // Both docs carry gentle x2 + coding x2 in 8 tokens → identical BM25, so
    // without a phrase signal the id tie-break wins and "1-scattered" (sorts
    // first) ranks #1. Only "2-phrase" has "gentle coding" contiguous (x2); the
    // phrase signal must overturn the tie-break and rank it first.
    const phraseDocs = [
      { id: "1-scattered", text: "gentle alpha coding beta gentle gamma coding delta" },
      { id: "2-phrase", text: "gentle coding alpha beta gentle coding gamma delta" },
    ];
    const index = await buildHybridIndex(phraseDocs, keywordOnly);
    const hits = await index.search("gentle coding");
    expect(hits[0]!.id).toBe("2-phrase");
  });

  it("leaves a single-token query unchanged (no phrase signal)", async () => {
    // A 1-token query has no phrase; ranking is keyword+vector as before.
    const index = await buildHybridIndex(docs, createHashEmbedder());
    const hits = await index.search("pnpm");
    expect(hits[0]!.id).toBe("pnpm");
  });
});
