// Hybrid index for the disposable index (plan 036 Phase 3 / spec 035 §F2).
// Fuses the keyword + vector signals with Reciprocal Rank Fusion (RRF) —
// robust and normalization-free (the two signals' raw scores are
// incomparable: keyword tf vs cosine in [-1,1]). The embedder is pluggable
// and async so the real transformers.js model is a drop-in; the bundled
// `createHashEmbedder` is a deterministic, zero-dependency fallback (also the
// test double) usable when no model is configured.

import { tokenize } from "../memory-tokenize.js";
import { buildKeywordIndex } from "./keyword-index.js";
import { buildVectorIndex } from "./vector-index.js";

export interface Embedder {
  /** Embed a document/passage for indexing. */
  embed(text: string): Promise<number[]>;
  /**
   * Optionally embed a search query with query-specific handling (some models
   * — e.g. EmbeddingGemma — use asymmetric query vs document prompts). When
   * absent, the index embeds queries with `embed` (symmetric models like the
   * hash embedder need nothing more).
   */
  embedQuery?(text: string): Promise<number[]>;
}

/**
 * Deterministic, zero-dependency fallback embedder: hashes each token (FNV-1a)
 * into a fixed-width bag-of-buckets vector. Shared tokens → shared buckets →
 * positive cosine. Lexical, not semantic — a functional fallback / test
 * double; the real transformers.js model is the quality embedder.
 */
export function createHashEmbedder(dimensions = 256): Embedder {
  return {
    embed(text) {
      const vector = new Array<number>(dimensions).fill(0);
      for (const term of tokenize(text)) {
        let hash = 2166136261;
        for (let i = 0; i < term.length; i++) {
          hash ^= term.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        const bucket = (hash >>> 0) % dimensions;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      return Promise.resolve(vector);
    },
  };
}

export interface HybridHit {
  id: string;
  score: number;
}

export interface HybridIndex {
  /** Fused (keyword + vector) ranking for the query, RRF-scored. */
  search(query: string, limit?: number): Promise<HybridHit[]>;
}

export async function buildHybridIndex(
  documents: { id: string; text: string }[],
  embedder: Embedder,
  options: { rrfK?: number } = {},
): Promise<HybridIndex> {
  const rrfK = options.rrfK ?? 60;
  const keyword = buildKeywordIndex(documents.map((doc) => ({ id: doc.id, text: doc.text })));
  const vectors: { id: string; vector: number[] }[] = [];
  for (const doc of documents) vectors.push({ id: doc.id, vector: await embedder.embed(doc.text) });
  const vector = buildVectorIndex(vectors);

  return {
    async search(query, limit) {
      // Use the query-specific embedding when the model provides one (asymmetric
      // models); otherwise the symmetric `embed`.
      const queryVector = await (embedder.embedQuery
        ? embedder.embedQuery(query)
        : embedder.embed(query));
      const keywordHits = keyword.search(query);
      // Only positive cosine counts as a semantic match (drop orthogonal/opposite).
      const vectorHits = vector.search(queryVector).filter((hit) => hit.score > 0);

      // RRF: a doc's fused score is the sum of 1/(k + rank) across the lists
      // it appears in. No score normalization needed; docs ranking high in
      // both signals win.
      const fused = new Map<string, number>();
      const contribute = (hits: { id: string }[]): void => {
        hits.forEach((hit, rank) => {
          fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (rrfK + rank + 1));
        });
      };
      contribute(keywordHits);
      contribute(vectorHits);

      const ranked = [...fused.entries()].map(([id, score]) => ({ id, score }));
      ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return limit != null ? ranked.slice(0, limit) : ranked;
    },
  };
}
