// Vector index for the disposable index (plan 036 Phase 3 / spec 035 §F2).
// Brute-force cosine similarity over stored embeddings — pure given the
// vectors; the text→vector embedder is a separate, pluggable async concern.
// Brute force is fine to ~tens of thousands of docs (spec); an ANN index
// (hnswlib-wasm / Voy) is post-MVP, triggered by size.

export interface VectorHit {
  id: string;
  score: number;
}

export interface VectorIndex {
  /** Entries ranked by cosine similarity to `query` (desc), id tie-break. */
  search(query: number[], limit?: number): VectorHit[];
}

/** Cosine similarity in [-1, 1]; 0 when either vector has zero magnitude. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const shared = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < shared; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  let normA = 0;
  for (const x of a) normA += x * x;
  let normB = 0;
  for (const y of b) normB += y * y;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function buildVectorIndex(entries: { id: string; vector: number[] }[]): VectorIndex {
  // Copy so later caller mutation of the input can't corrupt the index.
  const stored = entries.map((entry) => ({ id: entry.id, vector: entry.vector }));
  return {
    search(query, limit) {
      const hits = stored.map((entry) => ({
        id: entry.id,
        score: cosineSimilarity(query, entry.vector),
      }));
      hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return limit != null ? hits.slice(0, limit) : hits;
    },
  };
}
