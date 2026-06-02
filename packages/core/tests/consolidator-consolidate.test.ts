// Consolidator per-item orchestrator (plan 036 Phase 4 / spec 035 §F5). Drives
// the whole pipeline over one inbox item against a REAL temp vault + fakes:
// claim → parse → navigate → judge → apply → complete. No network (fake LLM),
// no real index (fake recall/listActive).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ConsolidatorApplyStore,
  type LlmClient,
  type Vault,
  claimInboxItem,
  consolidateInboxItem,
  createVault,
  listInbox,
  writeInbox,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let vault: Vault;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-consolidate-"));
  vault = createVault({ dataDir });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fakeStore() {
  const calls = { create: [] as Record<string, unknown>[] };
  let n = 0;
  const store: ConsolidatorApplyStore = {
    createMemory: (input) => {
      calls.create.push(input);
      return { memory: { id: `mem_${n++}` } };
    },
    updateMemory: () => null,
    archiveMemory: () => null,
    getMemory: () => null,
  };
  return { store, calls };
}

function fakeClient(content: string): LlmClient {
  return { complete: async () => ({ content, model: "gpt-x", usage: null }) };
}

function baseDeps(store: ConsolidatorApplyStore, llmClient: LlmClient) {
  return {
    vault,
    recall: async () => [],
    listActive: () => [],
    llmClient,
    store,
    actorId: "system-consolidator",
  };
}

describe("consolidateInboxItem", () => {
  it("consolidates an item end-to-end: claim → judge → apply → complete", async () => {
    const ref = writeInbox(vault, "Anna moved to Berlin.", {
      now: () => 1000,
      generateId: () => "inbox_a",
    });
    const { store, calls } = fakeStore();
    const client = fakeClient(
      JSON.stringify({
        action: "create",
        title: "Anna",
        body: "Anna lives in Berlin.",
        tags: ["person"],
        rationale: "novel topic",
        confidence: 0.97,
      }),
    );

    const result = await consolidateInboxItem(ref.relPath, baseDeps(store, client));

    expect(result).toMatchObject({ status: "consolidated", outcome: { kind: "created" } });
    expect(calls.create[0]).toMatchObject({ title: "Anna", body: "Anna lives in Berlin." });
    // The item was completed — gone from the inbox, no stale claim left.
    expect(listInbox(vault)).toEqual([]);
    expect(vault.listMarkdown("inbox/.processing")).toEqual([]);
  });

  it("returns claimed_by_other when the item is already claimed", async () => {
    const ref = writeInbox(vault, "x", { now: () => 1000, generateId: () => "inbox_a" });
    claimInboxItem(vault, ref.relPath, { now: () => 2000 }); // someone else won it
    const { store } = fakeStore();
    const result = await consolidateInboxItem(ref.relPath, baseDeps(store, fakeClient("{}")));
    expect(result).toEqual({ status: "claimed_by_other" });
  });

  it("leaves the claim for retry on an unusable model response (judge_error)", async () => {
    const ref = writeInbox(vault, "some fact", { now: () => 1000, generateId: () => "inbox_a" });
    const { store, calls } = fakeStore();
    const result = await consolidateInboxItem(
      ref.relPath,
      baseDeps(store, fakeClient("not json at all")),
    );

    expect(result.status).toBe("judge_error");
    expect(calls.create.length).toBe(0); // nothing applied
    // Not completed — still claimed in .processing for the reaper to retry.
    expect(vault.listMarkdown("inbox/.processing").length).toBe(1);
    expect(listInbox(vault)).toEqual([]); // not back in pending yet (reaper's job)
  });

  it("routes a low-confidence augment to a new doc rather than touching the target", async () => {
    const ref = writeInbox(vault, "Maybe Anna likes tea.", {
      now: () => 1000,
      generateId: () => "inbox_a",
    });
    const { store, calls } = fakeStore();
    // augment at 0.5 → below the propose floor → create_new (S12).
    const client = fakeClient(
      JSON.stringify({
        action: "augment",
        target_id: "mem_anna",
        addition: "likes tea",
        rationale: "uncertain",
        confidence: 0.5,
      }),
    );

    const result = await consolidateInboxItem(ref.relPath, baseDeps(store, client));

    expect(result).toMatchObject({ status: "consolidated", outcome: { kind: "created_new" } });
    expect(calls.create[0]).toMatchObject({ body: "Maybe Anna likes tea." });
  });
});
