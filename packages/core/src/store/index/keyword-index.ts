// Keyword index for the disposable index (plan 036 Phase 3 / spec 035 §F2).
// A deterministic, dependency-free inverted index over the corpus, reusing
// the shared tokenizer so keyword relevance matches the rest of the system.
// `search` scores each doc by the summed term-frequency of the matching
// query terms. Rebuildable from the markdown at any time (the index is
// disposable). MiniSearch/FlexSearch remain a drop-in option if richer
// ranking is later needed — the index is swappable.

import { tokenize } from "../memory-tokenize.js";

export interface KeywordHit {
  id: string;
  score: number;
}

export interface KeywordIndex {
  /** Docs matching any query term, ranked by summed tf (desc), id tie-break. */
  search(query: string, limit?: number): KeywordHit[];
}

export function buildKeywordIndex(documents: { id: string; text: string }[]): KeywordIndex {
  // term → (docId → term frequency)
  const postings = new Map<string, Map<string, number>>();

  for (const doc of documents) {
    const counts = new Map<string, number>();
    for (const term of tokenize(doc.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      let posting = postings.get(term);
      if (!posting) {
        posting = new Map<string, number>();
        postings.set(term, posting);
      }
      posting.set(doc.id, tf);
    }
  }

  return {
    search(query, limit) {
      const scores = new Map<string, number>();
      for (const term of new Set(tokenize(query))) {
        const posting = postings.get(term);
        if (!posting) continue;
        for (const [id, tf] of posting) scores.set(id, (scores.get(id) ?? 0) + tf);
      }
      const hits = [...scores.entries()].map(([id, score]) => ({ id, score }));
      hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return limit != null ? hits.slice(0, limit) : hits;
    },
  };
}
