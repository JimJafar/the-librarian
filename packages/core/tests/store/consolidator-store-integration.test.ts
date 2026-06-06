// Consolidator ↔ store wiring (plan 036 Phase 4 / spec 035 §F5). Pins that the
// markdown LibrarianStore can submit raw text to the inbox and run the
// consolidator over it end-to-end against the REAL store (real vault, git, index
// — only the LLM is faked).

import { execFileSync } from "node:child_process";
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

  it("augments an existing memory through the real store (no-clobber appended body)", async () => {
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    const { memory } = store.createMemory({ title: "Anna", body: "Lives in Paris." });
    store.submitToInbox("Anna moved to Berlin");

    const summary = await store.consolidateInbox({
      llmClient: fakeClient(
        JSON.stringify({
          action: "augment",
          target_id: memory.id,
          addition: "Now in [[Berlin]].",
          rationale: "adds the move",
          confidence: 0.97,
        }),
      ),
    });

    expect(summary).toMatchObject({ consolidated: 1 });
    const updated = store.getMemory(memory.id);
    expect(updated?.body).toContain("Lives in Paris."); // original preserved (no-clobber)
    expect(updated?.body).toContain("[[Berlin]]"); // new info woven in
  });

  it("leaves the vault git tree clean after a judge-error sweep", async () => {
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    store.submitToInbox("unparseable submission");
    // judge_error leaves the claim in .processing; the final sweep commit must
    // capture that move so the working tree stays clean (Phase-7 git push).
    await store.consolidateInbox({ llmClient: fakeClient("not json at all") });
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: path.join(dataDir, "vault"),
      encoding: "utf8",
    });
    expect(porcelain.trim()).toBe("");
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

  it("carries submission hints (agent_id/project_key) onto the consolidated memory", async () => {
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    store.submitToInbox("Anna lives in Berlin.", {
      agentId: "agent-a",
      projectKey: "proj-x",
      tags: ["person"],
    });
    await store.consolidateInbox({
      llmClient: fakeClient(
        JSON.stringify({
          action: "create",
          title: "Anna",
          body: "Anna lives in Berlin.",
          tags: [],
          rationale: "novel",
          confidence: 0.97,
        }),
      ),
    });
    const anna = store.listMemories({ status: "active" }).memories.find((m) => m.title === "Anna");
    expect(anna).toMatchObject({ agent_id: "agent-a", project_key: "proj-x" });
  });

  it("records an intake decision-log run + per-item op through the real store (spec 043 C1)", async () => {
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    store.submitToInbox("Anna lives in Berlin.");
    await store.consolidateInbox({
      trigger: "tick",
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

    // The decision log is queryable from the same store — one run, one op, with
    // the full outcome captured (filing itself is unchanged; this is observational).
    const runs = store.listConsolidationRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "tick", status: "completed", consolidated: 1 });
    const ops = store.getConsolidationOperations(runs[0]!.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      action: "create",
      outcome: "applied",
      confidence: 0.97,
      rationale: "novel topic",
    });
    // And the sidecar landed OUTSIDE the git vault, like curation-runs.json.
    expect(fs.existsSync(path.join(dataDir, "consolidation-runs.json"))).toBe(true);
  });
});
