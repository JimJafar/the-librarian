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

  it("rebuildIndex refreshes the memory projection from events.jsonl", () => {
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

      // Wipe the memory projection tables. rebuildIndex replays
      // events.jsonl into a fresh projection.
      store.db.exec("DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM events;");

      store.rebuildIndex();

      const memoryCount = (
        store.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }
      ).n;
      expect(memoryCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it("migrates a pre-PR-7 v18 DB with a populated session_events_fts cleanly", () => {
    // Reported by the Hermes deploy: the v18 → v19 migration crashed at
    // startup. The original PR 7 drop code tried to pre-drop the FTS5
    // shadow tables (`session_events_fts_data` / `_idx` / `_content` /
    // `_docsize` / `_config`) before the virtual table — but SQLite
    // refuses (`table … may not be dropped`), so the first statement
    // threw and the whole migration aborted. The fix: drop only the
    // virtual table, which cleans up its own shadows atomically.
    //
    // We construct a v18-shaped DB by reusing the store's `db` handle
    // (a fresh store gives us a real SQLite connection without
    // importing `node:sqlite` directly — the vitest SSR transformer
    // mangles the `node:` prefix), then reopen at v18.
    {
      const setup = createLibrarianStore({ dataDir });
      try {
        setup.db.exec(`
          CREATE VIRTUAL TABLE session_events_fts USING fts5(summary);
          INSERT INTO session_events_fts (summary) VALUES ('seed row');
          PRAGMA user_version = 18;
        `);
      } finally {
        setup.close();
      }
    }

    // Pre-fix this throw'd `table session_events_fts_data may not be
    // dropped` and aborted boot. Post-fix the migration runs clean.
    const store = createLibrarianStore({ dataDir });
    try {
      const remaining = store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'session_events%' OR name = 'sessions'",
        )
        .all() as Array<{ name: string }>;
      expect(remaining).toEqual([]);
      // Memory side rebuilt from JSONL (empty in this fixture).
      expect(store.listAll({})).toEqual([]);
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

  it("auto-rebuilds the memory projection when the on-disk user_version is stale", () => {
    // Simulate an older sentinel by setting user_version back to 5; the
    // next open should re-init the projection tables without losing
    // ledger-backed memory data.
    let memoryId: string;

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

        store.db.exec("PRAGMA user_version = 5");
      } finally {
        store.close();
      }
    }

    {
      const store = createLibrarianStore({ dataDir });
      try {
        expect(store.getMemory(memoryId)).toBeTruthy();
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
        // Section 4d.3 — category/visibility/scope columns dropped.
        store.db.exec(
          `INSERT INTO memories (
            id, title, body, agent_id, project_key,
            status, priority, confidence, tags_json, applies_to_json,
            supersedes_json, conflicts_with_json, created_at, updated_at,
            last_recalled_at, recall_count, usefulness_score
          ) VALUES (
            'mem_ghost', 'Ghost row', 'Not in JSONL.', 'codex',
            NULL, 'active', 'normal', 'working', '[]', '[]', '[]', '[]',
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

describe("conversation_state authoritative table (T1.1)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-conv-state-table-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function tableExists(store: ReturnType<typeof createLibrarianStore>, name: string): boolean {
    const row = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return Boolean(row);
  }

  it("creates conversation_state and no longer creates the retired domain tables on first open", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      expect(tableExists(store, "conversation_state")).toBe(true);
      // D16 retired the entire domain model.
      expect(tableExists(store, "domains")).toBe(false);
      expect(tableExists(store, "signal_rules")).toBe(false);
      expect(tableExists(store, "token_domain_bindings")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("preserves conversation_state rows across schema-version bumps", () => {
    // conversation_state is SQLite-authoritative (no JSONL ledger
    // source-of-truth), so it must survive the drop-and-rebuild path that
    // fires when the on-disk user_version is below PROJECTION_SCHEMA_VERSION.
    {
      const store = createLibrarianStore({ dataDir });
      try {
        store.db
          .prepare(
            "INSERT INTO conversation_state (conv_id, harness, session_id, off_record, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "claude:abc",
            "claude-code",
            null,
            0,
            "2026-05-27T00:00:00.000Z",
            "2026-05-27T00:00:00.000Z",
          );
        store.db.exec("PRAGMA user_version = 5");
      } finally {
        store.close();
      }
    }

    {
      const store = createLibrarianStore({ dataDir });
      try {
        expect(
          (
            store.db.prepare("SELECT COUNT(*) AS n FROM conversation_state").get() as {
              n: number;
            }
          ).n,
        ).toBe(1);
      } finally {
        store.close();
      }
    }
  });
});

describe("Classifier-verdict columns on memories (T1.2 / Section 4a)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-classifier-columns-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function columnExists(
    store: ReturnType<typeof createLibrarianStore>,
    table: string,
    column: string,
  ): boolean {
    const rows = store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }

  it("creates memories with is_global/requires_approval columns and no domain column on first open", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      expect(columnExists(store, "memories", "is_global")).toBe(true);
      expect(columnExists(store, "memories", "requires_approval")).toBe(true);
      // D16 dropped the per-memory domain column.
      expect(columnExists(store, "memories", "domain")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("creates memories with classified/classification_attempts columns on first open (Section 4a)", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      expect(columnExists(store, "memories", "classified")).toBe(true);
      expect(columnExists(store, "memories", "classification_attempts")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("legacy-bridge writes land at classified=1 (no worker action needed)", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      const { memory } = store.createMemory({
        agent_id: "codex",
        title: "Legacy classification test",
        body: "A memory written through the legacy bridge.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });
      const row = store.db
        .prepare("SELECT classified, classification_attempts FROM memories WHERE id = ?")
        .get(memory.id) as { classified: number; classification_attempts: number };
      expect(row.classified).toBe(1);
      expect(row.classification_attempts).toBe(0);
    } finally {
      store.close();
    }
  });

  it("pendingClassification writes land at classified=0 with conservative defaults", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      const { memory } = store.createMemory(
        {
          agent_id: "codex",
          title: "Pending classification test",
          body: "Conservative-default landing while the worker decides.",
          category: "tools",
          visibility: "common",
          scope: "tool",
        },
        { pendingClassification: true },
      );
      const row = store.db
        .prepare(
          "SELECT classified, classification_attempts, is_global, requires_approval, status " +
            "FROM memories WHERE id = ?",
        )
        .get(memory.id) as {
        classified: number;
        classification_attempts: number;
        is_global: number;
        requires_approval: number;
        status: string;
      };
      expect(row.classified).toBe(0);
      expect(row.classification_attempts).toBe(0);
      expect(row.is_global).toBe(0);
      expect(row.requires_approval).toBe(1);
      expect(row.status).toBe("proposed");
    } finally {
      store.close();
    }
  });

  it("defaults a newly created memory to is_global=0, requires_approval=0", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      const { memory } = store.createMemory({
        agent_id: "codex",
        title: "Default verdict test",
        body: "A memory with no classifier inputs.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });
      const row = store.db
        .prepare("SELECT is_global, requires_approval FROM memories WHERE id = ?")
        .get(memory.id) as {
        is_global: number;
        requires_approval: number;
      };
      expect(row.is_global).toBe(0);
      expect(row.requires_approval).toBe(0);
    } finally {
      store.close();
    }
  });
});
