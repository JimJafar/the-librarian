// Reference chunker (rethink T24 / spec §9 D5). Splits a reference doc into
// embeddable chunks: by ATX-heading structure first (a section is the natural
// retrieval unit), then size-bound windows with modest overlap inside any
// oversized section. Each chunk carries a heading-breadcrumb anchor (e.g.
// "Manual > Tuning") and its char range in the source, so a search hit can
// point INTO a large document instead of truncating it.
//
// Size bounds are derived from the production embedder's real budget:
// EmbeddingGemma's train context is 2048 tokens, minus the llama-embedder's
// 32-token safety margin and ~10 tokens of document-prompt wrapper ≈ 2000
// tokens per embed. The chunker works in chars (the hash embedder has no
// tokenizer), so at a conservative ~3 chars/token even a token-dense 6000-char
// chunk stays within budget; typical English (~4 chars/token) lands ≈ 1500
// tokens with headroom. Overlap is 600 chars (10%) so a fact straddling a cut
// is embedded whole in at least one chunk. The llama embedder still truncates
// defensively, but with these bounds it should never need to.
//
// Heading/fence heuristics match reference-section.ts: ATX headings only,
// fenced code blocks (``` / ~~~) tracked so a `# comment` inside a sample is
// not a heading. Operates on the raw string (no newline normalization) so
// char ranges always slice back to the on-disk content.

export interface ReferenceChunk {
  /** Exact source slice: `markdown.slice(start, end) === text`. */
  text: string;
  /** Heading breadcrumb ("Manual > Tuning"); "" for content before any heading. */
  anchor: string;
  /** Char offset into the source markdown, inclusive. */
  start: number;
  /** Char offset into the source markdown, exclusive. */
  end: number;
}

export interface ChunkOptions {
  /** Max chunk size in chars (default 6000 ≈ 1500–2000 tokens, see header). */
  maxChunkChars?: number;
  /** Overlap between adjacent size-split chunks (default 600). */
  overlapChars?: number;
}

export const DEFAULT_MAX_CHUNK_CHARS = 6000;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 600;

interface Section {
  anchor: string;
  start: number;
  end: number;
}

/** Split into heading-delimited sections with breadcrumb anchors + char ranges. */
function splitIntoSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const crumbs: { level: number; text: string }[] = [];
  let sectionStart = 0;
  let sectionAnchor = "";
  let inFence = false;
  let lineStart = 0;

  const flush = (end: number): void => {
    if (end > sectionStart) sections.push({ anchor: sectionAnchor, start: sectionStart, end });
  };

  while (lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(lineStart, lineEnd);

    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (heading) {
      flush(lineStart); // close the running section before this heading line
      const level = heading[1]?.length ?? 1;
      while (crumbs.length > 0 && (crumbs[crumbs.length - 1]?.level ?? 0) >= level) crumbs.pop();
      crumbs.push({ level, text: (heading[2] ?? "").trim() });
      sectionStart = lineStart;
      sectionAnchor = crumbs.map((crumb) => crumb.text).join(" > ");
    }
    lineStart = lineEnd + 1;
  }
  flush(markdown.length);
  return sections;
}

/**
 * Chunk a reference document: one chunk per heading section, size-split with
 * overlap when a section exceeds the max. Whitespace-only chunks are dropped
 * (they carry nothing searchable). Deterministic — same input + options, same
 * chunks — which is what lets the embedding cache validate by chunk hash.
 */
export function chunkReference(markdown: string, options: ChunkOptions = {}): ReferenceChunk[] {
  const max = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlap = options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;
  const chunks: ReferenceChunk[] = [];

  for (const section of splitIntoSections(markdown)) {
    let pos = section.start;
    while (pos < section.end) {
      let end = Math.min(pos + max, section.end);
      if (end < section.end) {
        // Soft break: prefer the last newline in the window's back half, so
        // chunks end on line boundaries when the prose allows it.
        const lastNewline = markdown.lastIndexOf("\n", end - 1);
        if (lastNewline > pos + max / 2) end = lastNewline + 1;
      }
      const text = markdown.slice(pos, end);
      if (text.trim().length > 0) {
        chunks.push({ text, anchor: section.anchor, start: pos, end });
      }
      if (end >= section.end) break;
      pos = Math.max(pos + 1, end - overlap); // overlap back, but always advance
    }
  }
  return chunks;
}
