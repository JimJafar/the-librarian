// Recall/similarity tokenizer — storage-agnostic, shared by the SQLite and
// markdown backends (plan 036 Phase 2). Lowercase, strip to a
// word/path-char alphabet, drop tokens ≤ 2 chars and a small stopword set.
// Extracted from memory-store.ts so search + duplicate-detection score
// identically on both backends.

import { normalizeString } from "../constants.js";

const STOPWORDS = ["the", "and", "for", "with", "that", "this", "from", "into", "agent", "memory"];

export function tokenize(text: string): string[] {
  return normalizeString(text)
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .filter((term) => !STOPWORDS.includes(term));
}
