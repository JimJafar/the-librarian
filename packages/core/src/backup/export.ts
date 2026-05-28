// Portable export of the current store contents (spec: persistence-backup-restore,
// B1) — a human-/tool-readable dump of memories, distinct from a backup
// (which is for restore). `json` is one object; `ndjson` is one tagged record per
// line.
//
// sessions-rethink PR 7 — the sessions section is retired with the rest of
// the session subsystem.

import type { LibrarianStore } from "../store/librarian-store.js";

export type ExportFormat = "ndjson" | "json";

export function exportData(store: LibrarianStore, options: { format: ExportFormat }): string {
  const memories = store.listAll({}); // no status filter → every memory

  if (options.format === "json") {
    return `${JSON.stringify({ memories }, null, 2)}\n`;
  }

  const lines = memories.map((memory) => JSON.stringify({ type: "memory", ...memory }));
  return lines.length ? `${lines.join("\n")}\n` : "";
}
