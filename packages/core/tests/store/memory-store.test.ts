// Memory-store behavior tests.
//
// Migrated from the original packages/core/tests/store.test.js as part
// of T3.3 (second wave of the staged node:test → Vitest migration that
// began in T3.2). Behavior coverage is identical to the pre-migration
// suite — these tests pin the protected-category, visibility-scoping,
// project-filter, tombstone, and conflict-detection contracts of the
// memory CRUD surface.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ScopedStore {
  store: LibrarianStore;
  dataDir: string;
}

function makeScopedStore(): ScopedStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-memory-store-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function teardown(scope: ScopedStore | null): void {
  if (!scope) return;
  try {
    scope.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(scope.dataDir, { recursive: true, force: true });
}

describe("LibrarianStore memory CRUD", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("protected identity and relationship memories are proposed until approved", () => {
    const { store } = scope!;
    const result = store.createMemory({
      agent_id: "codex",
      title: "User values continuity",
      body: "The user wants durable relational context preserved carefully.",
      category: "relationship",
      visibility: "common",
      scope: "global",
      priority: "core",
      confidence: "working",
    });

    expect(result.status).toBe("proposed");
    expect(
      store.searchMemories({ query: "relational continuity", categories: ["relationship"] }).length,
    ).toBe(0);

    const approved = store.approveProposal(
      result.memory.id,
      "approve",
      {
        body: "The user wants durable relationship context preserved carefully and reviewed before activation.",
      },
      "dashboard",
    );

    expect(approved.status).toBe("active");
    expect(store.startContext({ agent_id: "codex" }).text).toContain(
      "durable relationship context",
    );
    expect(() =>
      store.updateMemory(approved.id, { body: "Direct edits should not be allowed." }, "codex"),
    ).toThrow(/Protected memories/);
  });

  it("generic updates cannot activate or convert protected memories", () => {
    const { store } = scope!;
    const proposed = store.createMemory({
      agent_id: "codex",
      title: "Protected proposal",
      body: "Relationship memories must wait for approval.",
      category: "relationship",
      visibility: "common",
      scope: "global",
    });

    expect(() => store.updateMemory(proposed.memory.id, { status: "active" }, "codex")).toThrow(
      /status changes/,
    );
    expect(store.getMemory(proposed.memory.id).status).toBe("proposed");

    const ordinary = store.createMemory({
      agent_id: "codex",
      title: "Ordinary tool note",
      body: "This starts as a tool note.",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });

    expect(() => store.updateMemory(ordinary.memory.id, { category: "identity" }, "codex")).toThrow(
      /Protected memory categories/,
    );
    expect(store.getMemory(ordinary.memory.id).category).toBe("tools");
  });

  it("common memory is shared but agent-private memory stays private", () => {
    const { store } = scope!;
    store.createMemory({
      agent_id: "codex",
      title: "Shared project convention",
      body: "All agents should use the project-key the-librarian for this repository.",
      category: "projects",
      visibility: "common",
      scope: "project",
      project_key: "the-librarian",
    });
    const privateResult = store.createMemory({
      agent_id: "codex",
      title: "Codex operating note",
      body: "Codex should run the behavior tests after changing MCP transport.",
      category: "lessons",
      visibility: "agent_private",
      scope: "project",
      project_key: "the-librarian",
    });

    const codex = store.searchMemories({
      agent_id: "codex",
      query: "behavior tests MCP",
      project_key: "the-librarian",
    });
    expect(codex.some((memory) => memory.id === privateResult.memory.id)).toBe(true);

    const claude = store.searchMemories({
      agent_id: "claude",
      query: "behavior tests MCP",
      project_key: "the-librarian",
    });
    expect(claude.some((memory) => memory.id === privateResult.memory.id)).toBe(false);

    const noPrivate = store.searchMemories({
      agent_id: "codex",
      query: "behavior tests MCP",
      project_key: "the-librarian",
      include_private: false,
    });
    expect(noPrivate.some((memory) => memory.id === privateResult.memory.id)).toBe(false);
  });

  it("project filters prevent unrelated project memories from leaking into recall", () => {
    const { store } = scope!;
    const alpha = store.createMemory({
      agent_id: "codex",
      title: "Alpha deploy command",
      body: "The deploy command for alpha is npm run alpha-deploy.",
      category: "projects",
      visibility: "common",
      scope: "project",
      project_key: "alpha",
    });
    const beta = store.createMemory({
      agent_id: "codex",
      title: "Beta deploy command",
      body: "The deploy command for beta is npm run beta-deploy.",
      category: "projects",
      visibility: "common",
      scope: "project",
      project_key: "beta",
    });

    const alphaRecall = store.searchMemories({ query: "deploy command", project_key: "alpha" });
    expect(alphaRecall.some((memory) => memory.id === alpha.memory.id)).toBe(true);
    expect(alphaRecall.some((memory) => memory.id === beta.memory.id)).toBe(false);
  });

  it("archiveMemory tombstones a memory and verification adjusts usefulness without erasing history", () => {
    const { store } = scope!;
    const result = store.createMemory({
      agent_id: "codex",
      title: "Old test command",
      body: "The old test command was npm run old-test.",
      category: "tools",
      visibility: "common",
      scope: "project",
      project_key: "the-librarian",
    });

    expect(
      store.verifyMemory(result.memory.id, "useful", "Helped pick a test.", "codex")
        .usefulness_score,
    ).toBe(1);
    expect(
      store.verifyMemory(result.memory.id, "not_useful", "Command was removed.", "codex")
        .usefulness_score,
    ).toBe(0);
    expect(store.archiveMemory(result.memory.id, "dashboard").status).toBe("archived");

    expect(store.searchMemories({ query: "old-test", project_key: "the-librarian" }).length).toBe(
      0,
    );
    expect(
      store
        .readEvents()
        .some(
          (event: { event_type: string; memory_id: string }) =>
            event.event_type === "memory.archived" && event.memory_id === result.memory.id,
        ),
    ).toBe(true);
  });

  it("similar memories no longer block writes — duplicates surface as an informational signal", () => {
    const { store } = scope!;
    store.createMemory({
      agent_id: "codex",
      title: "Dashboard style preference",
      body: "Prefer compact dashboard controls for memory review workflows.",
      category: "preferences",
      visibility: "common",
      scope: "project",
      project_key: "the-librarian",
      tags: ["dashboard", "memory", "review", "controls"],
    });

    const second = store.createMemory({
      agent_id: "codex",
      title: "Dashboard style preference",
      body: "Prefer compact dashboard controls for memory review workflows — repeated phrasing.",
      category: "preferences",
      visibility: "common",
      scope: "project",
      project_key: "the-librarian",
      tags: ["dashboard", "memory", "review", "controls"],
    });

    expect(second.status).toBe("active");
    expect(second.memory.id).toBeTruthy();
    expect(second.duplicates.length).toBeGreaterThanOrEqual(1);
  });

  describe("rowToMemory corrupt-JSON defence", () => {
    it("getMemory survives a corrupt tags_json column and falls back to []", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "test",
        title: "Corrupt tags test",
        body: "This memory will have its tags_json column manually corrupted.",
        category: "tools",
        visibility: "common",
        scope: "project",
        tags: ["valid-tag"],
      });

      // Verify clean read before corruption.
      const before = store.getMemory(memory.id);
      expect(before.tags).toEqual(["valid-tag"]);

      // Directly corrupt the SQLite column (bypass the projection).
      store.db.exec(
        `UPDATE memories SET tags_json = 'memory-hygiene-crash' WHERE id = '${memory.id}'`,
      );

      // Must not throw — fail-soft fallback to [].
      const after = store.getMemory(memory.id);
      expect(after).toBeTruthy();
      expect(after.tags).toEqual([]);
      expect(after.title).toBe("Corrupt tags test");
    });

    it("getMemory survives a corrupt applies_to_json column and falls back to []", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "test",
        title: "Corrupt applies_to test",
        body: "Testing applies_to_json corruption.",
        category: "tools",
        visibility: "common",
        scope: "project",
        applies_to: ["agent-a"],
      });

      store.db.exec(
        `UPDATE memories SET applies_to_json = 'not-json-at-all' WHERE id = '${memory.id}'`,
      );

      const after = store.getMemory(memory.id);
      expect(after.applies_to).toEqual([]);
    });

    it("getMemory survives a corrupt supersedes_json column and falls back to []", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "test",
        title: "Corrupt supersedes test",
        body: "Testing supersedes_json corruption.",
        category: "tools",
        visibility: "common",
        scope: "project",
      });

      store.db.exec(
        `UPDATE memories SET supersedes_json = 'garbage-data' WHERE id = '${memory.id}'`,
      );

      const after = store.getMemory(memory.id);
      expect(after.supersedes).toEqual([]);
    });

    it("getMemory survives a corrupt conflicts_with_json column and falls back to []", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "test",
        title: "Corrupt conflicts_with test",
        body: "Testing conflicts_with_json corruption.",
        category: "tools",
        visibility: "common",
        scope: "project",
      });

      store.db.exec(
        `UPDATE memories SET conflicts_with_json = 'raw-string-boom' WHERE id = '${memory.id}'`,
      );

      const after = store.getMemory(memory.id);
      expect(after.conflicts_with).toEqual([]);
    });

    it("getMemory survives a corrupt curator_note column and falls back to null", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "test",
        title: "Corrupt curator_note test",
        body: "Testing curator_note corruption.",
        category: "tools",
        visibility: "common",
        scope: "project",
      });

      // curator_note starts as null for a non-curated memory — set it to
      // a raw string to simulate corruption.
      store.db.exec(
        `UPDATE memories SET curator_note = 'corrupt-curator-note' WHERE id = '${memory.id}'`,
      );

      const after = store.getMemory(memory.id);
      expect(after.curator_note).toBeNull();
    });

    it("listMemories does not crash when a row has a corrupt JSON column", () => {
      const { store } = scope!;
      // Create two clean rows and one corrupt row.
      store.createMemory({
        agent_id: "test",
        title: "Clean memory one",
        body: "This one is fine.",
        category: "tools",
        visibility: "common",
        scope: "project",
      });
      const { memory: corrupt } = store.createMemory({
        agent_id: "test",
        title: "Soon to be corrupt",
        body: "Will be corrupted.",
        category: "tools",
        visibility: "common",
        scope: "project",
      });
      store.createMemory({
        agent_id: "test",
        title: "Clean memory two",
        body: "Also fine.",
        category: "tools",
        visibility: "common",
        scope: "project",
      });

      store.db.exec(`UPDATE memories SET tags_json = 'memory-hygiene' WHERE id = '${corrupt.id}'`);

      // listMemories must return all three rows — the corrupt row gets
      // tags: [] and the query doesn't crash.
      const result = store.listMemories({});
      expect(result.total).toBe(3);
      expect(result.memories).toHaveLength(3);

      const corruptRow = result.memories.find((m) => m.id === corrupt.id);
      expect(corruptRow).toBeTruthy();
      expect(corruptRow.tags).toEqual([]);
    });

    it("stderr is written when corrupt JSON is detected", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "test",
        title: "Stderr test",
        body: "Corruption should produce a stderr log line.",
        category: "tools",
        visibility: "common",
        scope: "project",
      });

      const writeSpy = vi.spyOn(process.stderr, "write");
      try {
        store.db.exec(
          `UPDATE memories SET applies_to_json = 'broken-json' WHERE id = '${memory.id}'`,
        );

        store.getMemory(memory.id);

        expect(writeSpy).toHaveBeenCalledTimes(1);
        const call = writeSpy.mock.calls[0]?.[0] as string;
        expect(call).toContain("[librarian] rowToMemory: corrupt JSON array column");
        expect(call).toContain(memory.id);
      } finally {
        writeSpy.mockRestore();
      }
    });
  });

  describe("legacy category → is_global / requires_approval derivation (T1.3)", () => {
    it("identity memories derive requires_approval=1, is_global=1 and route to proposed", () => {
      const { store } = scope!;
      const { memory, status } = store.createMemory({
        agent_id: "codex",
        title: "Owner identity",
        body: "Jim is the owner.",
        category: "identity",
        visibility: "common",
        scope: "global",
      });
      expect(status).toBe("proposed");
      const row = store.db
        .prepare("SELECT is_global, requires_approval FROM memories WHERE id = ?")
        .get(memory.id) as { is_global: number; requires_approval: number };
      expect(row.is_global).toBe(1);
      expect(row.requires_approval).toBe(1);
    });

    it("relationship memories derive requires_approval=1, is_global=1", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "codex",
        title: "Working relationship",
        body: "Jim collaborates with Claude as a senior peer.",
        category: "relationship",
        visibility: "common",
        scope: "global",
      });
      const row = store.db
        .prepare("SELECT is_global, requires_approval FROM memories WHERE id = ?")
        .get(memory.id) as { is_global: number; requires_approval: number };
      expect(row.is_global).toBe(1);
      expect(row.requires_approval).toBe(1);
    });

    it("preferences memories derive is_global=1 but requires_approval=0", () => {
      const { store } = scope!;
      const { memory, status } = store.createMemory({
        agent_id: "codex",
        title: "Coding preference",
        body: "Prefers terse responses.",
        category: "preferences",
        visibility: "common",
        scope: "global",
      });
      expect(status).toBe("active");
      const row = store.db
        .prepare("SELECT is_global, requires_approval FROM memories WHERE id = ?")
        .get(memory.id) as { is_global: number; requires_approval: number };
      expect(row.is_global).toBe(1);
      expect(row.requires_approval).toBe(0);
    });

    it("non-protected non-global categories derive both booleans as 0", () => {
      const { store } = scope!;
      for (const category of ["tools", "lessons", "projects", "environment", "people"] as const) {
        const { memory } = store.createMemory({
          agent_id: "codex",
          title: `Note about ${category}`,
          body: `A ${category} memory.`,
          category,
          visibility: "common",
          scope: "global",
        });
        const row = store.db
          .prepare("SELECT is_global, requires_approval FROM memories WHERE id = ?")
          .get(memory.id) as { is_global: number; requires_approval: number };
        expect(row.is_global, `is_global for category=${category}`).toBe(0);
        expect(row.requires_approval, `requires_approval for category=${category}`).toBe(0);
      }
    });

    it("rowToMemory surfaces is_global / requires_approval as booleans on the read path", () => {
      const { store } = scope!;
      const { memory } = store.createMemory({
        agent_id: "codex",
        title: "Identity for readback",
        body: "Boolean roundtrip.",
        category: "identity",
        visibility: "common",
        scope: "global",
      });
      const fetched = store.getMemory(memory.id);
      expect(fetched).toBeTruthy();
      expect(fetched.is_global).toBe(true);
      expect(fetched.requires_approval).toBe(true);
      expect(fetched.domain).toBe("general");
    });
  });
});
