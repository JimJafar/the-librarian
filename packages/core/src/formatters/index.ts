// Memory-side recall formatter. The session handover formatters
// (renderHandover / renderHandoverMarkdown / renderHandoverProse and the
// HandoverPayload type) were retired with the rest of the session
// subsystem in sessions-rethink PR 7.

export interface RecallItem {
  id?: string;
  title: string;
  body: string;
}

export interface FormatRecallOptions {
  // When true, prefix each line with the memory's id in brackets so callers can
  // pass it to `verify_memory` after using a recalled item. Default off so the
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
      const idPrefix = options.includeIds && memory.id ? `[${memory.id}] ` : "";
      return `- ${idPrefix}${memory.title}: ${memory.body}`;
    })
    .join("\n")}`;
}
