// Parity gate (plan 036 Phase 2): the markdown backend IS a MemoryStore.
//
// `createMarkdownMemoryStore` is typed `: MemoryStore`, so the compiler
// already enforces full interface conformance (every method, exact
// signatures). This test exercises the core verb contract through a
// `MemoryStore`-typed reference (no markdown-specific surface).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarkdownMemoryStore, createVault } from "@librarian/core";
import type { MemoryStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-parity-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("markdown backend — MemoryStore parity", () => {
  it("runs the create → recall → flag → archive verb contract via the MemoryStore surface", () => {
    // Typed as the interface — only MemoryStore methods are in scope here.
    const store: MemoryStore = createMarkdownMemoryStore({ vault: createVault({ dataDir }) });

    const { status, memory } = store.createMemory({
      agent_id: "codex",
      title: "Use pnpm",
      body: "Always pnpm, never npm.",
      tags: ["tooling"],
    });
    expect(status).toBe("active");

    expect(store.getMemory(memory.id)?.title).toBe("Use pnpm");
    expect(store.searchMemories({ query: "pnpm" }).map((m) => m.id)).toContain(memory.id);

    // Flagging routes the memory to review without changing its status, and it
    // still surfaces in recall (soft-demote, not exclusion).
    expect(store.flagMemory(memory.id, "looks outdated", "codex")?.status).toBe("active");
    expect(store.searchMemories({ query: "pnpm" }).map((m) => m.id)).toContain(memory.id);

    store.archiveMemory(memory.id);
    expect(store.searchMemories({ query: "pnpm" })).toEqual([]);
    expect(store.getMemory(memory.id)?.status).toBe("archived");
  });

  it("routes a protected write to the proposal flow and back to active on approve", () => {
    const store: MemoryStore = createMarkdownMemoryStore({ vault: createVault({ dataDir }) });
    const { status, memory } = store.createMemory(
      { agent_id: "codex", title: "Owner", body: "Jim owns this." },
      { requires_approval: true },
    );
    expect(status).toBe("proposed");
    expect(store.approveProposal(memory.id)?.status).toBe("active");
  });
});
