// A memoizing wrapper around an Embedder.
//
// The corpus index is rebuilt from scratch whenever a memory is written (the
// store invalidates its cached index on every `onWrite`), and each rebuild
// re-embeds EVERY active memory. Under the real model (EmbeddingGemma on CPU)
// that makes a bulk groom — e.g. a seed import ingesting N inbox items one
// at a time — quadratic: item k re-embeds the k-1 docs already filed. For a few
// hundred memories that's tens of thousands of CPU embeddings, i.e. glacial.
//
// A document's embedding is a pure function of its text, so we cache it. The
// cache is keyed by a hash of the input and survives index rebuilds, so each
// distinct document is embedded once across a whole sweep — O(N) instead of
// O(N^2). A changed/augmented doc has different text → a fresh key → a correct
// re-embed, so the cache never serves a stale vector. The cache is therefore
// bounded by the set of distinct doc texts (active memories + any reference docs
// embedded via search_references), not by call volume.
//
// Only documents are cached. Queries always bypass the cache: they're near-unique
// per recall, so caching them would only grow the map without ever hitting. We
// expose `embedQuery` UNCONDITIONALLY — routing to the inner model's own
// embedQuery when it has one (preserving the query/document asymmetry of e.g.
// EmbeddingGemma), else its symmetric `embed`. This matters because the hybrid
// index falls back to `embed` for queries when an embedder has no `embedQuery`
// (hybrid-index.ts) — so a symmetric model (the hash embedder) would otherwise
// route every distinct query through the cached `embed` and fill it unbounded.

import { createHash } from "node:crypto";
import type { Embedder } from "./hybrid-index.js";

function keyFor(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Wrap an embedder so repeated `embed(text)` calls for the same text reuse the
 * first computed vector. Unbounded by design — a vault's active-memory set is
 * the natural bound, and entries cost ~3KB each (768 floats). Returns a new
 * Embedder; the inner one is untouched.
 */
export function createCachingEmbedder(inner: Embedder): Embedder {
  const cache = new Map<string, number[]>();
  return {
    // Callers embed documents sequentially (the index build loops; the
    // intake sweep is serial), so a concurrent same-key miss can't happen —
    // we cache the resolved vector, not the in-flight promise.
    async embed(text: string): Promise<number[]> {
      const key = keyFor(text);
      const hit = cache.get(key);
      if (hit) return hit;
      const vector = await inner.embed(text);
      cache.set(key, vector);
      return vector;
    },
    // Always present, always uncached — see the module header.
    embedQuery: (text: string) => (inner.embedQuery ?? inner.embed)(text),
    // The wrapper doesn't change the model, so its identity passes through
    // (the persistent embedding cache keys on it).
    ...(inner.modelId ? { modelId: inner.modelId } : {}),
  };
}
