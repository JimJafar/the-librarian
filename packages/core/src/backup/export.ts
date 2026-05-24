// Portable export of the current store contents (spec: persistence-backup-restore,
// B1) — a human-/tool-readable dump of memories + sessions, distinct from a backup
// (which is for restore). `json` is one object; `ndjson` is one tagged record per
// line.
//
// Sessions are read straight from the canonical `sessions` table (ALL statuses and
// visibilities, uncapped) — NOT via `listSessions`, which clamps to 100 rows and
// defaults to active+paused + common-only, all of which would silently drop data
// from an export.

import type { LibrarianStore } from "../store/librarian-store.js";

export type ExportFormat = "ndjson" | "json";

export function exportData(store: LibrarianStore, options: { format: ExportFormat }): string {
  const memories = store.listAll({}); // no status filter → every memory
  const sessions = store.db
    .prepare("SELECT * FROM sessions ORDER BY started_at, id")
    .all() as Record<string, unknown>[];

  if (options.format === "json") {
    return `${JSON.stringify({ memories, sessions }, null, 2)}\n`;
  }

  const lines = [
    ...memories.map((memory) => JSON.stringify({ type: "memory", ...memory })),
    ...sessions.map((session) => JSON.stringify({ type: "session", ...session })),
  ];
  return lines.length ? `${lines.join("\n")}\n` : "";
}
