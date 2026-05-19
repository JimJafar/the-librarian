// Rebuild-parity tests for the SQLite projection.
//
// These were moved out of store.test.js / sessions.test.js as part of T3.2:
// projection.ts now owns the rebuild + per-event apply paths, so the tests
// that exercise rebuild parity belong with it. First wave of the staged
// node:test → Vitest migration (more follow in T3.3+/T4.1+/T5.1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibrarianStore } from "../../src/store.js";

describe("SQLite projection rebuild parity", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-projection-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rebuilds memories + FTS + snapshot from events.jsonl when the store is reopened", () => {
    const store = new LibrarianStore({ dataDir });
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

    const rebuilt = new LibrarianStore({ dataDir });
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
    const store = new LibrarianStore({ dataDir });
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

    const rebuilt = new LibrarianStore({ dataDir });
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
    const store = new LibrarianStore({ dataDir });
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
