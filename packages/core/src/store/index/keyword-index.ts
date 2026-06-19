// Keyword index for the disposable index (plan 036 Phase 3 / spec 035 §F2;
// BM25 upgrade 2026-06-19). A deterministic, dependency-free inverted index over
// the corpus, reusing the shared tokenizer so keyword relevance matches the rest
// of the system. `search` scores each doc by Okapi BM25 — IDF (rare query terms
// outweigh common ones) × saturating term-frequency, length-normalised — so a
// doc that matches ALL the query terms beats one that merely spams a single
// common term (the old summed-tf failure: "gentle coding" lost to a doc with
// "coding"×13 and no "gentle"). Rebuildable from the markdown at any time (the
// index is disposable). MiniSearch/FlexSearch remain a drop-in option if richer
// ranking is later needed — the index is swappable.

import { tokenize } from "../memory-tokenize.js";

export interface KeywordHit {
  id: string;
  score: number;
}

export interface KeywordIndex {
  /** Docs matching any query term, ranked by BM25 (desc), id tie-break. */
  search(query: string, limit?: number): KeywordHit[];
}

// Okapi BM25 free parameters. k1 controls term-frequency saturation (how fast
// extra occurrences stop helping); b controls length normalisation (0 = none,
// 1 = full). 1.2 / 0.75 are the standard, robust defaults.
const K1 = 1.2;
const B = 0.75;

export function buildKeywordIndex(documents: { id: string; text: string }[]): KeywordIndex {
  // term → (docId → term frequency)
  const postings = new Map<string, Map<string, number>>();
  // docId → token count, for BM25 length normalisation.
  const docLength = new Map<string, number>();
  let totalLength = 0;

  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    docLength.set(doc.id, tokens.length);
    totalLength += tokens.length;
    const counts = new Map<string, number>();
    for (const term of tokens) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      let posting = postings.get(term);
      if (!posting) {
        posting = new Map<string, number>();
        postings.set(term, posting);
      }
      posting.set(doc.id, tf);
    }
  }

  const docCount = documents.length;
  const avgdl = docCount > 0 ? totalLength / docCount : 0;

  return {
    search(query, limit) {
      const scores = new Map<string, number>();
      for (const term of new Set(tokenize(query))) {
        const posting = postings.get(term);
        if (!posting) continue;
        const df = posting.size;
        // BM25 IDF — the always-non-negative variant, so a term in every doc
        // contributes ~0 rather than going negative and penalising a match.
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        for (const [id, tf] of posting) {
          const len = docLength.get(id) ?? 0;
          const norm = avgdl > 0 ? 1 - B + (B * len) / avgdl : 1;
          const contribution = idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
          scores.set(id, (scores.get(id) ?? 0) + contribution);
        }
      }
      const hits = [...scores.entries()].map(([id, score]) => ({ id, score }));
      hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return limit != null ? hits.slice(0, limit) : hits;
    },
  };
}
