// Relevant-section extraction for Tier-0 reference lookup (plan 036 Phase 3 /
// spec 035 §F3). A reference doc can be large; search_references should surface
// the matched section, not the whole file. Splits the markdown on ATX headings
// (content before the first heading is its own "preamble" section) and returns
// the section matching the most DISTINCT query tokens. Pure + deterministic:
// ties resolve to the earliest section.
//
// Scope/heuristics: ATX headings only (setext `===`/`---` underlines are not
// treated as headings — the corpus emits ATX); fenced code blocks (``` / ~~~)
// are tracked so a `# comment` line inside a code sample is not mistaken for a
// heading (length-agnostic fence heuristic — balanced fences assumed). Tokens
// are compared with trailing in-word punctuation (`. / - _`, which the shared
// tokenizer keeps for path tokens) stripped, so a sentence-final "tuning."
// still matches a "tuning" query.

import { tokenize } from "../memory-tokenize.js";

/** Strip trailing in-word punctuation the tokenizer keeps, for prose matching. */
function normalizeToken(term: string): string {
  return term.replace(/[./_-]+$/, "");
}

/** Split markdown into heading-delimited sections (preamble first, if any). */
function splitIntoSections(markdown: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n").trim());
  return sections.filter((section) => section.length > 0);
}

export function extractRelevantSection(markdown: string, query: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const sections = splitIntoSections(normalized);
  const first = sections[0];
  if (first === undefined) return normalized.trim();

  const queryTokens = new Set(tokenize(query).map(normalizeToken).filter(Boolean));
  if (queryTokens.size === 0) return first;

  let best = first;
  let bestScore = -1;
  for (const section of sections) {
    const present = new Set(tokenize(section).map(normalizeToken));
    // distinct-token overlap (not raw count) so a long section can't win on
    // volume alone — the section covering the most query terms wins.
    let score = 0;
    for (const token of queryTokens) if (present.has(token)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = section;
    }
  }
  return best;
}
