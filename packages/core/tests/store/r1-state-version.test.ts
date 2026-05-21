// R1 — sessions get an authoritative SQLite `state_version` column and
// a `session_state_changes` audit table populated by the projection.
// JSONL-canonical stays in place for this phase; R3 will cut state
// transitions over to SQLite-direct writes. These tests pin the new
// schema + handler behaviour ahead of that cutover.

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-r1-"));
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

interface StateChange {
  from_status: string | null;
  to_status: string;
  actor_agent_id: string | null;
  note: string | null;
}

function getStateVersion(store: LibrarianStore, sessionId: string): number {
  const row = store.db.prepare("SELECT state_version FROM sessions WHERE id = ?").get(sessionId) as
    | { state_version: number }
    | undefined;
  if (!row) throw new Error(`No session row for ${sessionId}`);
  return row.state_version;
}

function listStateChanges(store: LibrarianStore, sessionId: string): StateChange[] {
  return store.db
    .prepare(
      `SELECT from_status, to_status, actor_agent_id, note
       FROM session_state_changes
       WHERE session_id = ?
       ORDER BY id ASC`,
    )
    .all(sessionId) as StateChange[];
}

describe("R1 — sessions.state_version + session_state_changes", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("startSession produces state_version=1 and a null→active state-change row", () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "r1 start" });
    expect(session).not.toBeNull();
    expect(getStateVersion(store, session!.id)).toBe(1);
    const changes = listStateChanges(store, session!.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.from_status).toBeNull();
    expect(changes[0]?.to_status).toBe("active");
    expect(changes[0]?.actor_agent_id).toBe("bede");
  });

  it("checkpointSession bumps state_version but doesn't insert a state-change row (status unchanged)", () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "r1 cp" });
    store.checkpointSession({ session_id: session!.id, summary: "midway" });
    expect(getStateVersion(store, session!.id)).toBe(2);
    expect(listStateChanges(store, session!.id)).toHaveLength(1);
  });

  it("pauseSession bumps state_version and inserts an active→paused row", () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "r1 pause" });
    store.pauseSession({ session_id: session!.id, summary: "pause" });
    expect(getStateVersion(store, session!.id)).toBe(2);
    const changes = listStateChanges(store, session!.id);
    expect(changes).toHaveLength(2);
    expect(changes[1]?.from_status).toBe("active");
    expect(changes[1]?.to_status).toBe("paused");
  });

  it("endSession bumps state_version and inserts an active→ended row", () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "r1 end" });
    store.endSession({ session_id: session!.id });
    expect(getStateVersion(store, session!.id)).toBe(2);
    const changes = listStateChanges(store, session!.id);
    expect(changes.at(-1)?.from_status).toBe("active");
    expect(changes.at(-1)?.to_status).toBe("ended");
  });

  it("recordSessionEvent that resumes a paused session inserts a paused→active row", () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "r1 implicit-resume" });
    store.pauseSession({ session_id: session!.id, summary: "pause" });
    store.recordSessionEvent({ session_id: session!.id, type: "note", summary: "back" });
    expect(getStateVersion(store, session!.id)).toBe(3);
    const changes = listStateChanges(store, session!.id);
    expect(changes.at(-1)?.from_status).toBe("paused");
    expect(changes.at(-1)?.to_status).toBe("active");
  });

  it("continueSession on an ended session inserts an ended→paused row", () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "r1 resume-ended" });
    store.endSession({ session_id: session!.id });
    store.continueSession({ session_id: session!.id, target_harness: "claude-code" });
    const changes = listStateChanges(store, session!.id);
    expect(changes.at(-1)?.from_status).toBe("ended");
    expect(changes.at(-1)?.to_status).toBe("paused");
  });

  it("rebuildIndex from JSONL reproduces state_version + state-change counts", () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "r1 rebuild" });
    store.checkpointSession({ session_id: session!.id, summary: "1" });
    store.pauseSession({ session_id: session!.id, summary: "2" });
    store.recordSessionEvent({ session_id: session!.id, type: "note", summary: "3" });
    store.endSession({ session_id: session!.id });

    const beforeVersion = getStateVersion(store, session!.id);
    const beforeChanges = listStateChanges(store, session!.id);

    store.rebuildIndex();

    expect(getStateVersion(store, session!.id)).toBe(beforeVersion);
    const afterChanges = listStateChanges(store, session!.id);
    expect(afterChanges).toHaveLength(beforeChanges.length);
    expect(afterChanges.map((c) => `${c.from_status}->${c.to_status}`)).toEqual(
      beforeChanges.map((c) => `${c.from_status}->${c.to_status}`),
    );
  });
});
