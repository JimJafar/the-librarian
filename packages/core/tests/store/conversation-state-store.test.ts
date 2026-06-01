// T2.1 — Conversation-state registry behaviour tests.
//
// Pins the contract for the new per-conversation runtime store
// introduced in memory-domain-isolation §4.8. The registry is the
// connective tissue between a harness's conv_id and the Librarian
// session/memory surface — every test here is at the
// `createLibrarianStore.convState.*` boundary. (D16 dropped `domain`.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function makeScope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-conv-state-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function teardown(scope: Scope | null): void {
  if (!scope) return;
  try {
    scope.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(scope.dataDir, { recursive: true, force: true });
}

describe("conversation-state store (T2.1)", () => {
  let scope: Scope | null = null;

  beforeEach(() => {
    scope = makeScope();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("get returns null for an unknown conv_id", () => {
    expect(scope!.store.convState.get("claude:never-seen")).toBeNull();
  });

  it("upsert creates a row with all required fields, defaulting session_id and off_record", () => {
    const created = scope!.store.convState.upsert("claude:abc", {
      harness: "claude-code",
    });
    expect(created).toMatchObject({
      conv_id: "claude:abc",
      harness: "claude-code",
      session_id: null,
      off_record: false,
    });
    expect(created.created_at).toBe(created.updated_at);

    const fetched = scope!.store.convState.get("claude:abc");
    expect(fetched).toEqual(created);
  });

  it("upsert without harness on a new row throws", () => {
    expect(() => scope!.store.convState.upsert("claude:new", { off_record: true })).toThrow(
      /first-create requires `harness`/,
    );
  });

  it("upsert applies a patch to an existing row, preserves created_at, bumps updated_at", async () => {
    const created = scope!.store.convState.upsert("claude:abc", {
      harness: "claude-code",
    });
    // Force a millisecond gap so updated_at moves.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = scope!.store.convState.upsert("claude:abc", {
      off_record: true,
      session_id: "ses_test",
    });
    expect(updated.off_record).toBe(true);
    expect(updated.session_id).toBe("ses_test");
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(updated.updated_at >= created.updated_at).toBe(true);
  });

  it("upsert preserves fields that are not in the patch", () => {
    scope!.store.convState.upsert("claude:abc", {
      harness: "claude-code",
      session_id: "ses_initial",
      off_record: false,
    });
    const updated = scope!.store.convState.upsert("claude:abc", { off_record: true });
    expect(updated.session_id).toBe("ses_initial");
    expect(updated.harness).toBe("claude-code");
  });

  it("upsert explicitly null-ing session_id clears it", () => {
    scope!.store.convState.upsert("claude:abc", {
      harness: "claude-code",
      session_id: "ses_attached",
    });
    const cleared = scope!.store.convState.upsert("claude:abc", { session_id: null });
    expect(cleared.session_id).toBeNull();
  });

  it("clear removes the row", () => {
    scope!.store.convState.upsert("claude:abc", {
      harness: "claude-code",
    });
    scope!.store.convState.clear("claude:abc");
    expect(scope!.store.convState.get("claude:abc")).toBeNull();
  });

  it("clear is a no-op for an unknown conv_id", () => {
    expect(() => scope!.store.convState.clear("never-seen")).not.toThrow();
  });

  it("survives a store reopen — the row is SQLite-authoritative", () => {
    const { dataDir } = scope!;
    scope!.store.convState.upsert("claude:abc", {
      harness: "claude-code",
      session_id: "ses_durable",
    });
    scope!.store.close();
    const reopened = createLibrarianStore({ dataDir });
    try {
      const fetched = reopened.convState.get("claude:abc");
      expect(fetched).toMatchObject({
        conv_id: "claude:abc",
        harness: "claude-code",
        session_id: "ses_durable",
      });
    } finally {
      reopened.close();
      scope = { store: reopened, dataDir };
    }
  });
});
