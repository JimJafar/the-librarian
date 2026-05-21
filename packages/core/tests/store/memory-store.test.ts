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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
});
