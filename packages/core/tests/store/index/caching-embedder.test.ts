// createCachingEmbedder — memoizes document embeddings so the corpus index can
// be rebuilt (which it is, on every memory write) without re-embedding docs that
// haven't changed. This is what keeps a bulk groom (seed import) from going
// O(N^2) on the real CPU model. Tested with a call-counting fake embedder (no
// model load) so it runs in CI.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCorpusIndex,
  createCachingEmbedder,
  createHashEmbedder,
  createLibrarianStore,
  createVault,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function countingEmbedder() {
  const calls = { embed: 0, embedQuery: 0 };
  const embedder = {
    embed: async (text: string) => {
      calls.embed += 1;
      return [text.length, calls.embed];
    },
    embedQuery: async (text: string) => {
      calls.embedQuery += 1;
      return [text.length, -calls.embedQuery];
    },
  };
  return { embedder, calls };
}

describe("createCachingEmbedder", () => {
  it("embeds a given document once and reuses the vector on repeat calls", async () => {
    const { embedder, calls } = countingEmbedder();
    const cached = createCachingEmbedder(embedder);

    const first = await cached.embed("memory body");
    const second = await cached.embed("memory body");

    expect(calls.embed).toBe(1); // the inner model ran only once
    expect(second).toBe(first); // same cached vector reference
  });

  it("re-embeds when the document text changes (no stale vector)", async () => {
    const { embedder, calls } = countingEmbedder();
    const cached = createCachingEmbedder(embedder);

    await cached.embed("original");
    await cached.embed("augmented"); // a changed doc → different text → fresh embed

    expect(calls.embed).toBe(2);
  });

  it("routes queries to the inner model uncached, never populating the doc cache", async () => {
    const { embedder, calls } = countingEmbedder();
    const cached = createCachingEmbedder(embedder);

    await cached.embedQuery!("a query");
    await cached.embedQuery!("a query");
    expect(calls.embedQuery).toBe(2); // queries pass straight through, never cached

    // A query never lands in the doc cache: embedding the SAME text as a document
    // is a miss, so the inner model runs for it.
    await cached.embed("a query");
    expect(calls.embed).toBe(1);
  });

  it("exposes embedQuery even for a symmetric inner model, still bypassing the cache", async () => {
    let embedCalls = 0;
    const inner = {
      embed: async (text: string) => {
        embedCalls += 1;
        return [text.length];
      },
    };
    const cached = createCachingEmbedder(inner);

    // No inner embedQuery → falls back to inner.embed, but crucially does NOT go
    // through the cached embed, so the query can't pollute the doc cache. (This is
    // the bug guard: hybrid-index uses embed for queries when embedQuery is absent.)
    expect(cached.embedQuery).toBeDefined();
    await cached.embedQuery!("q");
    await cached.embed("q"); // same text, as a doc → still a cache miss
    expect(embedCalls).toBe(2);
  });
});

// The reason this wrapper exists: the store invalidates + rebuilds the corpus
// index on every memory write, re-embedding every active doc. A bulk groom does
// that N times over a growing corpus → O(N^2) embeds. One cached embedder across
// the rebuilds collapses it to O(N): each distinct doc embeds exactly once.
describe("createCachingEmbedder across corpus-index rebuilds (the O(N^2) fix)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-caching-embedder-"));
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      store.createMemory({ agent_id: "codex", title: "Piano", body: "tune it twice a year" });
      store.createMemory({ agent_id: "codex", title: "Sailing", body: "boats on open water" });
      store.createMemory({ agent_id: "codex", title: "Coffee", body: "ground fresh each morning" });
    } finally {
      store.close();
    }
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("re-embeds each doc once total across repeated index rebuilds, not once per rebuild", async () => {
    const inner = createHashEmbedder();
    let innerEmbedCalls = 0;
    const counting = {
      embed: (text: string) => {
        innerEmbedCalls += 1;
        return inner.embed(text);
      },
    };
    const embedder = createCachingEmbedder(counting);
    const vault = createVault({ dataDir });

    // Three rebuilds over the same 3-doc vault — what the store's invalidate-on-
    // write loop does during a sweep. Without the cache this is 9 embeds.
    await buildCorpusIndex(vault, { embedder });
    await buildCorpusIndex(vault, { embedder });
    await buildCorpusIndex(vault, { embedder });

    expect(innerEmbedCalls).toBe(3); // 3 distinct docs, embedded once each
  });
});
