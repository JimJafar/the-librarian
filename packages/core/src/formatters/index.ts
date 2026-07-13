// Memory-side recall formatter. The session handover formatters
// (renderHandover / renderHandoverMarkdown / renderHandoverProse and the
// HandoverPayload type) were retired with the rest of the session
// subsystem in sessions-rethink PR 7.

export interface RecallItem {
  id?: string;
  title: string;
  body: string;
  /**
   * Shelf provenance (spec 062 SC 5, T5). Present ONLY on a MULTI-shelf merged-recall hit — a
   * principal whose materialised recall shelf set has length > 1. Absent under the default /
   * single-shelf router, so this formatter's output stays BYTE-IDENTICAL to before. When set, the
   * hit renders a leading bracketed token: `[<label> (<id>)]` when the shelf carries a `shelfLabel`,
   * `[<id>]` otherwise (the decided "label with id in parentheses" format, spec 062 §6).
   */
  shelfId?: string;
  shelfLabel?: string;
}

export interface FormatRecallOptions {
  // When true, prefix each line with the memory's id in brackets so callers can
  // pass it to `flag_memory` after using a recalled item. Default off so the
  // existing prose-only output stays byte-identical for system-prompt injection
  // and other consumers that don't need ids.
  includeIds?: boolean;
}

export function formatRecall(
  memories: RecallItem[],
  heading: string = "Relevant Memories",
  options: FormatRecallOptions = {},
): string {
  if (!memories.length) return `${heading}\n\nNo relevant memories found.`;
  return `${heading}\n\n${memories
    .map((memory) => {
      // Shelf provenance token (spec 062 T5) leads the line so an agent reading a MERGED recall can
      // tell which shelf a hit came from. It renders ONLY when the hit carries shelf provenance —
      // i.e. a multi-shelf recall. A single-shelf recall omits it entirely, keeping the line
      // byte-identical to before (the inertness rule): `[<label> (<id>)]` labelled, else `[<id>]`.
      const shelfPrefix = memory.shelfId
        ? `[${memory.shelfLabel ? `${memory.shelfLabel} (${memory.shelfId})` : memory.shelfId}] `
        : "";
      const idPrefix = options.includeIds && memory.id ? `[${memory.id}] ` : "";
      return `- ${shelfPrefix}${idPrefix}${memory.title}: ${memory.body}`;
    })
    .join("\n")}`;
}
