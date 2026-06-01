// Backend-selection tests for createLibrarianStore (plan 036 Phase 2 cutover,
// incremental-behind-a-flag). The `markdown` backend routes memory/handoff to
// the git vault and conv-state/settings to sidecar JSON files; a residual
// SQLite db backs only the (dormant) curator until Phase 4. SQLite stays the
// default — no behaviour change for existing consumers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-backend-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const handoffDoc = [
  "## Start & intent",
  "do the thing.",
  "## Journey",
  "x then y.",
  "## Current state",
  "green.",
  "## What's left",
  "ship.",
  "## Open questions",
  "none.",
].join("\n\n");

describe("createLibrarianStore — backend selection", () => {
  it("markdown backend writes memories to the git vault and reads them back", () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      const { memory } = store.createMemory({
        agent_id: "codex",
        title: "Use pnpm",
        body: "Always pnpm.",
      });
      expect(fs.existsSync(path.join(dataDir, "vault", `memories/${memory.id}.md`))).toBe(true);
      expect(store.getMemory(memory.id)?.title).toBe("Use pnpm");
      expect(store.searchMemories({ query: "pnpm" }).map((m) => m.id)).toContain(memory.id);
    } finally {
      store.close();
    }
  });

  it("markdown backend routes handoffs to the vault and conv-state/settings to sidecar files", () => {
    const store = createLibrarianStore({
      dataDir,
      backend: "markdown",
      secretKey: Buffer.alloc(32, 7),
    });
    try {
      const { handoff_id } = store.handoffs.store(
        { title: "Handoff", document_md: handoffDoc, harness: "claude-code", tags: [] },
        { created_by_agent_id: "agent-a" },
      );
      expect(fs.existsSync(path.join(dataDir, "vault", `handoffs/${handoff_id}.md`))).toBe(true);

      store.convState.upsert("claude:abc", { harness: "claude-code" });
      expect(fs.existsSync(path.join(dataDir, "conv-state.json"))).toBe(true);

      store.setSetting("llm_token", "sk-x", { secret: true });
      expect(store.getSetting("llm_token")).toBe("sk-x");
      expect(fs.existsSync(path.join(dataDir, "settings.json"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("defaults to the sqlite backend (no vault dir created)", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({ agent_id: "codex", title: "t", body: "b" });
      expect(fs.existsSync(path.join(dataDir, "librarian.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, "vault"))).toBe(false);
    } finally {
      store.close();
    }
  });
});
