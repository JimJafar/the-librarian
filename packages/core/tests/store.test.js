import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertIncludes, withStore } from "../../../test/helpers.js";
import { LibrarianStore } from "../src/store.js";

test("protected identity and relationship memories are proposed until approved", async () => {
  await withStore((store) => {
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

    assert.equal(result.status, "proposed");
    assert.equal(
      store.searchMemories({ query: "relational continuity", categories: ["relationship"] }).length,
      0,
    );

    const approved = store.approveProposal(
      result.memory.id,
      "approve",
      {
        body: "The user wants durable relationship context preserved carefully and reviewed before activation.",
      },
      "dashboard",
    );

    assert.equal(approved.status, "active");
    assertIncludes(store.startContext({ agent_id: "codex" }).text, "durable relationship context");
    assert.throws(
      () =>
        store.updateMemory(approved.id, { body: "Direct edits should not be allowed." }, "codex"),
      /Protected memories/,
    );
  });
});

test("generic updates cannot activate or convert protected memories", async () => {
  await withStore((store) => {
    const proposed = store.createMemory({
      agent_id: "codex",
      title: "Protected proposal",
      body: "Relationship memories must wait for approval.",
      category: "relationship",
      visibility: "common",
      scope: "global",
    });

    assert.throws(
      () => store.updateMemory(proposed.memory.id, { status: "active" }, "codex"),
      /status changes/,
    );
    assert.equal(store.getMemory(proposed.memory.id).status, "proposed");

    const ordinary = store.createMemory({
      agent_id: "codex",
      title: "Ordinary tool note",
      body: "This starts as a tool note.",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });

    assert.throws(
      () => store.updateMemory(ordinary.memory.id, { category: "identity" }, "codex"),
      /Protected memory categories/,
    );
    assert.equal(store.getMemory(ordinary.memory.id).category, "tools");
  });
});

test("ordinary memories are active, searchable, snapshotted, and rebuildable from the ledger", async () => {
  const dataDir = fs.mkdtempSync(path.join("/tmp", "librarian-rebuild-"));
  const store = new LibrarianStore({ dataDir });
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

    assert.equal(result.status, "active");
    assert.equal(
      store.searchMemories({ query: "event ledger sqlite", project_key: "the-librarian" })[0].id,
      result.memory.id,
    );
    assertIncludes(
      fs.readFileSync(path.join(dataDir, "memories.md"), "utf8"),
      "JSONL is canonical",
    );

    store.close();
    const rebuilt = new LibrarianStore({ dataDir });
    try {
      const recalled = rebuilt.searchMemories({
        query: "Markdown rebuilt",
        project_key: "the-librarian",
      });
      assert.equal(recalled[0].id, result.memory.id);
    } finally {
      rebuilt.close();
    }
  } finally {
    try {
      store.close();
    } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("common memory is shared but agent-private memory stays private", async () => {
  await withStore((store) => {
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
    assert.ok(codex.some((memory) => memory.id === privateResult.memory.id));

    const claude = store.searchMemories({
      agent_id: "claude",
      query: "behavior tests MCP",
      project_key: "the-librarian",
    });
    assert.ok(!claude.some((memory) => memory.id === privateResult.memory.id));

    const noPrivate = store.searchMemories({
      agent_id: "codex",
      query: "behavior tests MCP",
      project_key: "the-librarian",
      include_private: false,
    });
    assert.ok(!noPrivate.some((memory) => memory.id === privateResult.memory.id));
  });
});

test("project filters prevent unrelated project memories from leaking into recall", async () => {
  await withStore((store) => {
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
    assert.ok(alphaRecall.some((memory) => memory.id === alpha.memory.id));
    assert.ok(!alphaRecall.some((memory) => memory.id === beta.memory.id));
  });
});

test("delete tombstones memories and verification changes usefulness without erasing history", async () => {
  await withStore((store) => {
    const result = store.createMemory({
      agent_id: "codex",
      title: "Old test command",
      body: "The old test command was npm run old-test.",
      category: "tools",
      visibility: "common",
      scope: "project",
      project_key: "the-librarian",
    });

    assert.equal(
      store.verifyMemory(result.memory.id, "useful", "Helped pick a test.", "codex")
        .usefulness_score,
      1,
    );
    assert.equal(
      store.verifyMemory(result.memory.id, "wrong", "Command was removed.", "codex")
        .usefulness_score,
      -1,
    );
    assert.equal(store.deleteMemory(result.memory.id, "dashboard").status, "deleted");

    assert.equal(
      store.searchMemories({ query: "old-test", project_key: "the-librarian" }).length,
      0,
    );
    assert.ok(
      store
        .readEvents()
        .some(
          (event) => event.event_type === "memory.deleted" && event.memory_id === result.memory.id,
        ),
    );
  });
});

test("conflicting memories are returned for resolution instead of silently saved", async () => {
  await withStore((store) => {
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

    const conflict = store.createMemory({
      agent_id: "codex",
      title: "Dashboard style preference",
      body: "Avoid compact dashboard controls for memory review workflows.",
      category: "preferences",
      visibility: "common",
      scope: "project",
      project_key: "the-librarian",
      tags: ["dashboard", "memory", "review", "controls"],
    });

    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.conflicts.length, 1);
    assert.ok(store.readEvents().some((event) => event.event_type === "memory.conflict_detected"));
  });
});
