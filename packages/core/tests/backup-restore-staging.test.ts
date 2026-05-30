import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  RESTORE_MARKER,
  applyPendingRestore,
  createBackup,
  createLibrarianStore,
  stageRestore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let backupDir: string;
let store: LibrarianStore;

function seed(s: LibrarianStore, title: string) {
  s.createMemory({
    agent_id: "claude",
    title,
    body: "body",
    category: "projects",
    visibility: "common",
    scope: "project",
    project_key: "the-librarian",
    priority: "normal",
    confidence: "working",
  });
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-restore-data-"));
  backupDir = path.join(dataDir, "backups");
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const markerPath = () => path.join(dataDir, RESTORE_MARKER);

describe("restart-staged restore", () => {
  it("stages a local bundle and applies it on the next boot", async () => {
    seed(store, "one");
    const { dir } = createBackup(store, { destDir: backupDir });
    const bundle = path.basename(dir);

    seed(store, "two"); // mutate AFTER the backup → 2 memories live
    expect(store.listAll({}).length).toBe(2);

    const result = await stageRestore(store, { bundleName: bundle, backupDir });
    expect(result).toEqual({ staged: bundle, restartRequired: true });
    expect(fs.existsSync(markerPath())).toBe(true);

    store.close(); // simulate shutdown
    const applied = applyPendingRestore(dataDir);
    expect(applied).toMatchObject({ applied: true, bundle });
    expect(fs.existsSync(markerPath())).toBe(false); // marker cleared

    store = createLibrarianStore({ dataDir });
    expect(store.listAll({}).length).toBe(1); // reverted to the backed-up state
  });

  it("refuses to stage a corrupt bundle — no marker, live data untouched", async () => {
    seed(store, "one");
    const { dir } = createBackup(store, { destDir: backupDir });
    const bundle = path.basename(dir);
    // Corrupt the stored ledger so its checksum no longer matches.
    fs.appendFileSync(path.join(dir, "events.jsonl.gz"), Buffer.from([0, 1, 2]));

    await expect(stageRestore(store, { bundleName: bundle, backupDir })).rejects.toThrow();
    expect(fs.existsSync(markerPath())).toBe(false);
    expect(store.listAll({}).length).toBe(1); // untouched
  });

  it("keeps the marker and leaves data untouched when the boot-restore fails", async () => {
    seed(store, "one");
    const { dir } = createBackup(store, { destDir: backupDir });
    const bundle = path.basename(dir);
    await stageRestore(store, { bundleName: bundle, backupDir });
    expect(fs.existsSync(markerPath())).toBe(true);

    // Corrupt the staged bundle AFTER staging (passes stage validation, fails at boot).
    fs.appendFileSync(path.join(dir, "librarian.sqlite.gz"), Buffer.from([9, 9, 9]));
    seed(store, "two");
    store.close();

    const applied = applyPendingRestore(dataDir);
    expect(applied.applied).toBe(false);
    expect(applied.error).toBeTruthy();
    expect(fs.existsSync(markerPath())).toBe(true); // marker kept for the operator

    store = createLibrarianStore({ dataDir });
    expect(store.listAll({}).length).toBe(2); // live data untouched (still has "two")
  });

  it("rejects an unsafe bundle name", async () => {
    await expect(stageRestore(store, { bundleName: "../escape", backupDir })).rejects.toThrow(
      /invalid bundle name/,
    );
  });

  it("applyPendingRestore is a no-op with no marker", () => {
    expect(applyPendingRestore(dataDir)).toEqual({ applied: false });
  });
});
