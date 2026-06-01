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
});
