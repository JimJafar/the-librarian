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

// Full-row snapshots — deep equality across every column so a restore that
// silently dropped a column / timestamps / events would fail.
function deepSnapshot(s: LibrarianStore) {
  return {
    memories: s.db.prepare("SELECT * FROM memories ORDER BY id").all(),
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
    const before = deepSnapshot(store);

    const { dir, manifest } = createBackup(store, { destDir });
    expect(manifest.schema_version).toBeGreaterThan(0);
    expect(manifest.files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["librarian.sqlite", "events.jsonl"]),
    );

    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    const result = restoreBackup(dir, { dataDir });
    expect(result.restored).toContain("librarian.sqlite");

    store = createLibrarianStore({ dataDir });
    expect(deepSnapshot(store)).toEqual(before);
  });

  it("never bundles the credential files (secret.key / admin.token) that live in the data dir", () => {
    seedMemory(store);
    // D0 writes these beside the store; a backup must stay key-free so a leaked
    // bundle is not a leaked key/token.
    fs.writeFileSync(path.join(dataDir, "secret.key"), "00".repeat(32), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, "admin.token"), "libadmin_example", { mode: 0o600 });

    const { dir, manifest } = createBackup(store, { destDir });

    const names = manifest.files.map((f) => f.name);
    expect(names).not.toContain("secret.key");
    expect(names).not.toContain("admin.token");
    // And the files are physically absent from the bundle directory, not merely
    // omitted from the manifest.
    expect(fs.existsSync(path.join(dir, "secret.key"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "admin.token"))).toBe(false);
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
  it("exports memories as JSON", () => {
    seedMemory(store);
    const parsed = JSON.parse(exportData(store, { format: "json" }));
    expect(parsed.memories.length).toBe(1);
  });

  it("exports one tagged record per line as NDJSON", () => {
    seedMemory(store);
    const types = exportData(store, { format: "ndjson" })
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).type)
      .sort();
    expect(types).toEqual(["memory"]);
  });
});
