// Indexes that back the curator evidence queries (curator-evidence.ts):
//   - the tombstone archive-reason correlated subqueries over `events`
//     (WHERE memory_id = ? AND event_type IN (...) ORDER BY created_at DESC)
//   - the per-session evidence query over `session_events`
//     (WHERE session_id = ? AND type IN (...) ORDER BY ... created_at DESC)
// Both run in the offline curator batch; the indexes keep them off full scans
// once a real store grows.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("curator evidence-query indexes", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-idx-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function indexNames(): string[] {
    const store = createLibrarianStore({ dataDir });
    try {
      return (
        store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
    } finally {
      store.close();
    }
  }

  it("creates an events(memory_id, event_type, created_at) index", () => {
    expect(indexNames()).toContain("idx_events_memory");
  });

  it("creates a session_events(session_id, type, created_at) index", () => {
    expect(indexNames()).toContain("idx_session_events_session");
  });

  it("the events index actually backs the tombstone archive-reason subquery", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      const plan = store.db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT e.payload_json FROM events e
              WHERE e.memory_id = ? AND e.event_type IN ('memory.archived', 'memory.deleted')
              ORDER BY e.created_at DESC LIMIT 1`,
        )
        .all() as Array<{ detail: string }>;
      const detail = plan.map((r) => r.detail).join(" | ");
      expect(detail).toContain("idx_events_memory");
    } finally {
      store.close();
    }
  });
});
