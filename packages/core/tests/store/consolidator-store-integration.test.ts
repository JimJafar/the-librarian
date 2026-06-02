// Consolidator ↔ store wiring (plan 036 Phase 4 / spec 035 §F5). Pins that the
// markdown LibrarianStore can submit raw text to the inbox and run the
// consolidator over it end-to-end against the REAL store (real vault, git, index
// — only the LLM is faked), and that the sqlite backend refuses both.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, type LlmClient, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-consol-store-"));
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

function fakeClient(content: string): LlmClient {
  return { complete: async () => ({ content, model: "gpt-x", usage: null }) };
}

describe("LibrarianStore consolidator wiring (markdown)", () => {
  it("submits raw text to the inbox and consolidates it into a memory", async () => {
    store = createLibrarianStore({ dataDir, backend: "markdown" });

    const ref = store.submitToInbox("Anna lives in Berlin.");
    expect(ref.relPath.startsWith("inbox/")).toBe(true);
    // The submission is in the inbox, NOT yet a memory.
    expect(store.searchMemories({ query: "Anna", status: "active" })).toEqual([]);

    const summary = await store.consolidateInbox({
      llmClient: fakeClient(
        JSON.stringify({
          action: "create",
          title: "Anna",
          body: "Anna lives in Berlin.",
          tags: ["person"],
          rationale: "novel topic",
          confidence: 0.97,
        }),
      ),
    });

    expect(summary).toMatchObject({ consolidated: 1, judgeErrors: 0, errored: 0 });
    // The consolidator filed it as a real, recallable memory.
    const found = store.searchMemories({ query: "Anna", status: "active" });
    expect(found.map((m) => m.title)).toContain("Anna");
  });

  it("consolidates a duplicate submission to a no-op (nothing created)", async () => {
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    store.submitToInbox("dupe");
    const summary = await store.consolidateInbox({
      llmClient: fakeClient(
        JSON.stringify({ action: "noop", rationale: "duplicate", confidence: 0.9 }),
      ),
    });
    expect(summary).toMatchObject({ consolidated: 1 });
    expect(store.listMemories({}).total).toBe(0);
  });

  it("rejects inbox operations on the sqlite backend", async () => {
    store = createLibrarianStore({ dataDir, backend: "sqlite" });
    expect(() => store!.submitToInbox("x")).toThrow(/markdown backend/);
    await expect(store.consolidateInbox({ llmClient: fakeClient("{}") })).rejects.toThrow(
      /markdown backend/,
    );
  });
});
