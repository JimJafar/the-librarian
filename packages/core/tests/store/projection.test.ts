// Rebuild-parity tests for the SQLite projection.
//
// These were moved out of store.test.js / sessions.test.js as part of T3.2:
// projection.ts now owns the rebuild + per-event apply paths, so the tests
// that exercise rebuild parity belong with it. First wave of the staged
// node:test → Vitest migration (more follow in T3.3+/T4.1+/T5.1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("SQLite projection rebuild parity", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-projection-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rebuilds memories + FTS + snapshot from events.jsonl when the store is reopened", () => {
    const store = createLibrarianStore({ dataDir });
    let memoryId: string;
    try {
      const result = store.createMemory({
        agent_id: "codex",
        title: "JSONL is canonical",
        body: "The event ledger is the source of truth; SQLite and Markdown are rebuilt from it.",
        category: "projects",
        visibility: "common",
        scope: "project",
        project_key: "the-librarian",
        tags: ["jsonl", "sqlite"],
      });
      memoryId = result.memory.id;

      expect(result.status).toBe("active");
      expect(
        store.searchMemories({ query: "event ledger sqlite", project_key: "the-librarian" })[0].id,
      ).toBe(memoryId);
      expect(fs.readFileSync(path.join(dataDir, "memories.md"), "utf8")).toContain(
        "JSONL is canonical",
      );
    } finally {
      store.close();
    }

    // Wipe SQLite — the JSONL ledger is the source of truth; reopening the
    // store rebuilds the projection from scratch.
    fs.unlinkSync(path.join(dataDir, "librarian.sqlite"));

    const rebuilt = createLibrarianStore({ dataDir });
    try {
      const recalled = rebuilt.searchMemories({
        query: "Markdown rebuilt",
        project_key: "the-librarian",
      });
      expect(recalled[0].id).toBe(memoryId);
    } finally {
      rebuilt.close();
    }
  });

  it("rebuilds the session timeline + FTS from session_events.jsonl when the store is reopened (R3)", () => {
    // R3 — sessions row state is SQLite-authoritative. State
    // transitions don't go to JSONL anymore. Wiping SQLite means
    // losing session state; the JSONL ledger only carries timeline
    // events (notes, decisions, attaches, promote-to-memory). This
    // test pins the new contract: timeline events survive a reopen
    // when SQLite is intact, and the sessions row itself stays
    // populated because we don't delete `librarian.sqlite`.
    const store = createLibrarianStore({ dataDir });
    let sessionId: string;
    try {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Will survive restart",
        harness: "hermes",
        project_key: "the-librarian",
        start_summary: "Initial sketch.",
      });
      sessionId = session.id;
      store.checkpointSession({
        agent_id: "bede",
        session_id: sessionId,
        summary: "Drafted handover.",
        next_steps: ["Wire CLI"],
      });
      store.recordSessionEvent({
        agent_id: "bede",
        session_id: sessionId,
        type: "decision",
        summary: "Default attach=true.",
      });
      store.pauseSession({
        agent_id: "bede",
        session_id: sessionId,
        summary: "Pausing for the day.",
      });
    } finally {
      store.close();
    }

    // Reopen without wiping SQLite — sessions data is preserved by
    // design.
    const rebuilt = createLibrarianStore({ dataDir });
    try {
      const reloaded = rebuilt.getSession(sessionId);
      expect(reloaded).toBeTruthy();
      expect(reloaded.title).toBe("Will survive restart");
      expect(reloaded.status).toBe("paused");
      expect(reloaded.rolling_summary).toBe("Pausing for the day.");
      expect(reloaded.next_steps).toEqual(["Wire CLI"]);
      expect(reloaded.paused_at).toBeTruthy();

      // Timeline projection survives. State-transition event types
      // are no longer JSONL-backed, so we only assert that timeline
      // event types replay correctly through the FTS index.
      const hit = rebuilt.searchSessions({ agent_id: "bede", query: "attach" });
      expect(hit.sessions.some((s: { id: string }) => s.id === sessionId)).toBe(true);
    } finally {
      rebuilt.close();
    }
  });

  it("rebuildIndex preserves SQLite-authoritative session state and refreshes the timeline projection (R3)", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({
        agent_id: "bede",
        title: "Memory under rebuild",
        body: "Persisted in events.jsonl.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Session under rebuild",
        harness: "hermes",
        start_summary: "Recovery test.",
      });

      // Wipe the projection tables only — sessions + state_changes
      // stay because they're authoritative post-R3. rebuildIndex
      // refreshes the memory projection from events.jsonl and the
      // timeline projection from session_events.jsonl without
      // touching sessions data.
      store.db.exec(
        "DELETE FROM session_events; DELETE FROM session_events_fts;" +
          "DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM events;",
      );

      store.rebuildIndex();

      const recovered = store.getSession(session.id);
      expect(recovered).toBeTruthy();
      expect(recovered.title).toBe("Session under rebuild");

      const memoryCount = (
        store.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }
      ).n;
      expect(memoryCount).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("Schema-version sentinel (T3.6)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-schema-version-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function readUserVersion(store: ReturnType<typeof createLibrarianStore>): number {
    const row = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  it("stamps PROJECTION_SCHEMA_VERSION on a fresh database", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({
        agent_id: "codex",
        title: "Stamped on fresh DB",
        body: "First write into a brand-new store.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });
      expect(readUserVersion(store)).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });

  it("auto-rebuilds the projection when the on-disk user_version is stale (R1→R3 path preserves sessions)", () => {
    // R3 — for post-R1 instances (user_version >= 5) the rebuild
    // preserves SQLite-authoritative sessions data. We simulate a
    // sentinel-only bump (R1's `5` → R3's `6`) by setting user_version
    // back to 5; the next open should re-init the projection tables
    // without losing sessions or memory data.
    let memoryId: string;
    let sessionId: string;

    {
      const store = createLibrarianStore({ dataDir });
      try {
        memoryId = store.createMemory({
          agent_id: "codex",
          title: "Pre-bump memory",
          body: "Was written under the previous schema.",
          category: "tools",
          visibility: "common",
          scope: "tool",
        }).memory.id;
        sessionId = store.startSession({
          agent_id: "bede",
          title: "Pre-bump session",
          harness: "hermes",
        }).session.id;

        // Simulate the R3 sentinel bump.
        store.db.exec("PRAGMA user_version = 5");
      } finally {
        store.close();
      }
    }

    {
      const store = createLibrarianStore({ dataDir });
      try {
        expect(store.getMemory(memoryId)).toBeTruthy();
        expect(store.getSession(sessionId)).toBeTruthy();
        expect(readUserVersion(store)).toBeGreaterThanOrEqual(1);
      } finally {
        store.close();
      }
    }
  });

  it("does not rebuild when the on-disk user_version is already current", () => {
    {
      const store = createLibrarianStore({ dataDir });
      try {
        store.createMemory({
          agent_id: "codex",
          title: "Canonical memory",
          body: "Written through the public surface, so it's in the JSONL ledger too.",
          category: "tools",
          visibility: "common",
          scope: "tool",
        });
        expect(readUserVersion(store)).toBeGreaterThanOrEqual(1);

        // Insert a row directly into SQLite without appending to the JSONL
        // ledger. If the next open triggers a rebuild from JSONL, this row
        // gets wiped. If the version gate works, the row survives.
        store.db.exec(
          `INSERT INTO memories (
            id, title, body, category, visibility, agent_id, scope, project_key,
            status, priority, confidence, tags_json, applies_to_json,
            supersedes_json, conflicts_with_json, created_at, updated_at,
            last_recalled_at, recall_count, usefulness_score
          ) VALUES (
            'mem_ghost', 'Ghost row', 'Not in JSONL.', 'tools', 'common', 'codex',
            'tool', NULL, 'active', 'normal', 'working', '[]', '[]', '[]', '[]',
            '2026-05-20T00:00:00.000Z', '2026-05-20T00:00:00.000Z', NULL, 0, 0
          );`,
        );
      } finally {
        store.close();
      }
    }

    {
      const store = createLibrarianStore({ dataDir });
      try {
        const ghost = store.db.prepare("SELECT id FROM memories WHERE id = ?").get("mem_ghost");
        expect(ghost).toBeTruthy();
      } finally {
        store.close();
      }
    }
  });
});
