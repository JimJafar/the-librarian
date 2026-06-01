// Relevant-section extraction for Tier-0 reference lookup (plan 036 Phase 3 /
// spec 035 §F3). A reference doc can be large; search_references should surface
// the matched section, not the whole file. Splits the markdown on ATX headings
// (content before the first heading is its own "preamble" section) and returns
// the section with the most query-token overlap. Pure + deterministic: ties
// resolve to the earliest section.

import { tokenize } from "../memory-tokenize.js";

/** Split markdown into heading-delimited sections (preamble first, if any). */
function splitIntoSections(markdown: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n").trim());
  return sections.filter((section) => section.length > 0);
}

export function extractRelevantSection(markdown: string, query: string): string {
  const sections = splitIntoSections(markdown);
  const first = sections[0];
  if (first === undefined) return markdown.trim();

  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return first;

  let best = first;
  let bestScore = -1;
  for (const section of sections) {
    const score = tokenize(section).filter((term) => queryTokens.has(term)).length;
    if (score > bestScore) {
      bestScore = score;
      best = section;
    }
  }
  return best;
}
