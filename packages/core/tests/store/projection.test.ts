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

  it("rebuilds session state + FTS from sessions.jsonl when the store is reopened", () => {
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

    fs.unlinkSync(path.join(dataDir, "librarian.sqlite"));

    const rebuilt = createLibrarianStore({ dataDir });
    try {
      const reloaded = rebuilt.getSession(sessionId);
      expect(reloaded).toBeTruthy();
      expect(reloaded.title).toBe("Will survive restart");
      expect(reloaded.status).toBe("paused");
      expect(reloaded.rolling_summary).toBe("Pausing for the day.");
      expect(reloaded.next_steps).toEqual(["Wire CLI"]);
      expect(reloaded.paused_at).toBeTruthy();

      const events = rebuilt.listSessionEvents({ session_id: sessionId });
      const types = events.events.map((event: { type: string }) => event.type);
      expect(types).toContain("started");
      expect(types).toContain("checkpointed");
      expect(types).toContain("decision");
      expect(types).toContain("paused");

      const hit = rebuilt.searchSessions({ agent_id: "bede", query: "handover" });
      expect(hit.sessions.some((s: { id: string }) => s.id === sessionId)).toBe(true);
    } finally {
      rebuilt.close();
    }
  });

  it("rebuildIndex restores both memory and session projections after an in-place DB wipe", () => {
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

      store.db.exec(
        // R1: session_state_changes references sessions(id) — delete it
        // first to keep the foreign-key constraint happy.
        "DELETE FROM session_state_changes;" +
          "DELETE FROM sessions; DELETE FROM session_events; DELETE FROM session_events_fts;" +
          "DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM events;",
      );
      expect(store.getSession(session.id)).toBeNull();

      store.rebuildIndex();

      const recovered = store.getSession(session.id);
      expect(recovered).toBeTruthy();
      expect(recovered.title).toBe("Session under rebuild");

      const memoryCount = store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
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

  it("auto-rebuilds the projection when the on-disk user_version is stale", () => {
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

        // Simulate a schema bump by rolling the on-disk pragma back to 0.
        // PRAGMA writes persist with the database file, so the next open
        // will see the stale version and trigger a rebuild.
        store.db.exec("PRAGMA user_version = 0");
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
