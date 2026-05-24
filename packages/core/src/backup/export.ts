// Portable export of the current store contents (spec: persistence-backup-restore,
// B1) — a human-/tool-readable dump of memories + sessions, distinct from a backup
// (which is for restore). `json` is one object; `ndjson` is one tagged record per
// line.

import type { LibrarianStore } from "../store/librarian-store.js";

export type ExportFormat = "ndjson" | "json";

// Large enough to export every session without the list's default cap.
const EXPORT_LIMIT = 1_000_000;

export function exportData(store: LibrarianStore, options: { format: ExportFormat }): string {
  const memories = store.listAll({});
  const sessions = store.listSessions({ limit: EXPORT_LIMIT }).sessions;

  if (options.format === "json") {
    return `${JSON.stringify({ memories, sessions }, null, 2)}\n`;
  }

  const lines = [
    ...memories.map((memory) => JSON.stringify({ type: "memory", ...memory })),
    ...sessions.map((session) => JSON.stringify({ type: "session", ...session })),
  ];
  return lines.length ? `${lines.join("\n")}\n` : "";
}
