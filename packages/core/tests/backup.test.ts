import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  BackupRestoreError,
  createBackup,
  createLibrarianStore,
  exportData,
  restoreBackup,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let destDir: string;
let store: LibrarianStore;

function seedMemory(s: LibrarianStore) {
  s.createMemory({
    agent_id: "claude",
    title: "pnpm not npm",
    body: "this repo uses pnpm",
    category: "projects",
    visibility: "common",
    scope: "project",
    project_key: "the-librarian",
    priority: "normal",
    confidence: "working",
  });
}

function startSession(s: LibrarianStore, extra: Record<string, unknown> = {}): string {
  const r = s.startSession({ agent_id: "claude", title: "work", harness: "claude-code", ...extra });
  return (r.session as { id: string }).id;
}

// Full-row snapshots — deep equality across every column, not just id/status, so a
// restore that silently dropped rolling_summary / timestamps / events would fail.
function deepSnapshot(s: LibrarianStore) {
  return {
    memories: s.db.prepare("SELECT * FROM memories ORDER BY id").all(),
    sessions: s.db.prepare("SELECT * FROM sessions ORDER BY id").all(),
    sessionEvents: s.readSessionEvents(),
    events: s.readEvents(),
  };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-backup-data-"));
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-backup-dest-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed by a test
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(destDir, { recursive: true, force: true });
});

describe("createBackup / restoreBackup", () => {
  it("round-trips the full store: seed → backup → wipe → restore → byte-identical state", () => {
    seedMemory(store);
    const sid = startSession(store);
    store.checkpointSession({ session_id: sid, summary: "did the backup module" });
    const before = deepSnapshot(store);

    const { dir, manifest } = createBackup(store, { destDir });
    expect(manifest.schema_version).toBeGreaterThan(0);
    expect(manifest.files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["librarian.sqlite", "events.jsonl", "session_events.jsonl"]),
    );

    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    const result = restoreBackup(dir, { dataDir });
    expect(result.restored).toContain("librarian.sqlite");

    store = createLibrarianStore({ dataDir });
    expect(deepSnapshot(store)).toEqual(before); // full fidelity incl. rolling_summary, timestamps, events
  });

  it("records a sha256 + byte size for every file", () => {
    seedMemory(store);
    const { manifest } = createBackup(store, { destDir });
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects a backup whose file no longer matches its checksum", () => {
    seedMemory(store);
    const { dir } = createBackup(store, { destDir });
    store.close();
    fs.appendFileSync(path.join(dir, "events.jsonl"), "tampered\n");
    expect(() => restoreBackup(dir, { dataDir })).toThrow(BackupRestoreError);
  });

  it("rejects a directory with no manifest", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lib-backup-empty-"));
    expect(() => restoreBackup(empty, { dataDir })).toThrow(BackupRestoreError);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("refuses a manifest with a path-traversal file name (no arbitrary write)", () => {
    const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-backup-evil-"));
    fs.writeFileSync(
      path.join(evilDir, "manifest.json"),
      JSON.stringify({
        format_version: 1,
        created_at: new Date().toISOString(),
        schema_version: 1,
        files: [{ name: "../escape.txt", sha256: "0".repeat(64), bytes: 0 }],
      }),
    );
    expect(() => restoreBackup(evilDir, { dataDir })).toThrow(/unsafe backup file name/);
    fs.rmSync(evilDir, { recursive: true, force: true });
  });
});

describe("exportData", () => {
  it("exports memories + sessions as JSON", () => {
    seedMemory(store);
    startSession(store);
    const parsed = JSON.parse(exportData(store, { format: "json" }));
    expect(parsed.memories.length).toBe(1);
    expect(parsed.sessions.length).toBe(1);
  });

  it("exports one tagged record per line as NDJSON", () => {
    seedMemory(store);
    startSession(store);
    const types = exportData(store, { format: "ndjson" })
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).type)
      .sort();
    expect(types).toEqual(["memory", "session"]);
  });

  it("includes EVERY session — ended, private, and beyond the list's 100-row cap", () => {
    const ended = startSession(store, { title: "ended one" });
    store.endSession({ session_id: ended });
    const priv = startSession(store, { title: "private one", visibility: "agent_private" });
    for (let i = 0; i < 100; i++) startSession(store, { title: `bulk ${i}` });

    const sessions = JSON.parse(exportData(store, { format: "json" })).sessions as {
      id: string;
    }[];
    expect(sessions.length).toBe(102); // 1 ended + 1 private + 100 bulk, none dropped
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(ended);
    expect(ids).toContain(priv);
  });
});
