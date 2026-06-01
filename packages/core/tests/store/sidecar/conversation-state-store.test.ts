// JSON conv-state store tests (plan 036 Phase 2). conv-state is ephemeral
// per-conversation runtime — kept on a sidecar JSON file OUTSIDE the git
// vault (decided 2026-06-01). Same ConversationStateStore contract as the
// SQLite store: get/upsert/clear, first-create requires harness, patch
// merges, durable across reopen.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ConversationStateStore, createJsonConversationStateStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-convstate-"));
  filePath = path.join(dir, "conv-state.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const make = (): ConversationStateStore => createJsonConversationStateStore({ filePath });

describe("JSON conv-state store", () => {
  it("get returns null for an unknown conv_id", () => {
    expect(make().get("claude:never")).toBeNull();
  });

  it("upsert creates a row (harness only) and get returns it", () => {
    const store = make();
    const created = store.upsert("claude:abc", { harness: "claude-code" });
    expect(created).toMatchObject({
      conv_id: "claude:abc",
      harness: "claude-code",
      session_id: null,
      off_record: false,
    });
    expect(created.created_at).toBe(created.updated_at);
    expect(store.get("claude:abc")).toEqual(created);
  });

  it("first-create without harness throws", () => {
    expect(() => make().upsert("claude:x", { off_record: true })).toThrow(
      /first-create requires `harness`/,
    );
  });

  it("upsert merges a patch, preserves created_at, bumps updated_at", async () => {
    const store = make();
    const created = store.upsert("claude:abc", { harness: "claude-code" });
    await new Promise((r) => setTimeout(r, 5));
    const updated = store.upsert("claude:abc", { off_record: true, session_id: "ses_1" });
    expect(updated.off_record).toBe(true);
    expect(updated.session_id).toBe("ses_1");
    expect(updated.harness).toBe("claude-code"); // preserved
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at >= created.updated_at).toBe(true);
  });

  it("explicit session_id: null clears the attached session", () => {
    const store = make();
    store.upsert("claude:abc", { harness: "claude-code", session_id: "ses_1" });
    expect(store.upsert("claude:abc", { session_id: null }).session_id).toBeNull();
  });

  it("clear removes the row; clear of an unknown id is a no-op", () => {
    const store = make();
    store.upsert("claude:abc", { harness: "claude-code" });
    store.clear("claude:abc");
    expect(store.get("claude:abc")).toBeNull();
    expect(() => store.clear("nope")).not.toThrow();
  });

  it("survives a reopen — the JSON file is the source of truth", () => {
    make().upsert("claude:abc", { harness: "claude-code", session_id: "ses_durable" });
    const reopened = make();
    expect(reopened.get("claude:abc")).toMatchObject({
      conv_id: "claude:abc",
      harness: "claude-code",
      session_id: "ses_durable",
    });
  });

  it("keeps each conv_id independent", () => {
    const store = make();
    store.upsert("a", { harness: "h1" });
    store.upsert("b", { harness: "h2" });
    expect(store.get("a")?.harness).toBe("h1");
    expect(store.get("b")?.harness).toBe("h2");
  });
});
