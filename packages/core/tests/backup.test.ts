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

function seed(s: LibrarianStore) {
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
  const started = s.startSession({
    agent_id: "claude",
    title: "backup work",
    harness: "claude-code",
  });
  s.checkpointSession({
    session_id: (started.session as { id: string }).id,
    summary: "did the backup module",
  });
}

function snapshot(s: LibrarianStore) {
  return {
    memories: s
      .listAll({})
      .map((m) => (m as { id: string }).id)
      .sort(),
    sessions: s
      .listSessions({ limit: 1000 })
      .sessions.map((x) => ({
        id: (x as { id: string }).id,
        status: (x as { status: string }).status,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
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
  it("round-trips the store: seed → backup → wipe → restore → identical", () => {
    seed(store);
    const before = snapshot(store);

    const { dir, manifest } = createBackup(store, { destDir });
    expect(manifest.schema_version).toBeGreaterThan(0);
    expect(manifest.files.map((f) => f.name)).toContain("librarian.sqlite");
    expect(manifest.files.map((f) => f.name)).toContain("events.jsonl");
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);

    // Wipe + restore into a fresh data dir, then re-open.
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    const result = restoreBackup(dir, { dataDir });
    expect(result.restored).toContain("librarian.sqlite");

    store = createLibrarianStore({ dataDir });
    expect(snapshot(store)).toEqual(before);
  });

  it("records a sha256 + byte size for every file", () => {
    seed(store);
    const { manifest } = createBackup(store, { destDir });
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects a backup whose file no longer matches its checksum", () => {
    seed(store);
    const { dir } = createBackup(store, { destDir });
    store.close();
    // Corrupt a backed-up ledger after the manifest was written.
    fs.appendFileSync(path.join(dir, "events.jsonl"), "tampered\n");
    expect(() => restoreBackup(dir, { dataDir })).toThrow(BackupRestoreError);
  });

  it("rejects a directory with no manifest", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lib-backup-empty-"));
    expect(() => restoreBackup(empty, { dataDir })).toThrow(BackupRestoreError);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe("exportData", () => {
  it("exports memories + sessions as JSON", () => {
    seed(store);
    const parsed = JSON.parse(exportData(store, { format: "json" }));
    expect(parsed.memories.length).toBe(1);
    expect(parsed.sessions.length).toBe(1);
  });

  it("exports one tagged record per line as NDJSON", () => {
    seed(store);
    const lines = exportData(store, { format: "ndjson" }).trim().split("\n");
    const types = lines.map((l) => JSON.parse(l).type).sort();
    expect(types).toEqual(["memory", "session"]);
  });
});
