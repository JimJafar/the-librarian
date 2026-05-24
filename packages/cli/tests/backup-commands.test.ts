import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/runtime.js";

function seed(store: LibrarianStore, title: string) {
  store.createMemory({
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

function backupDirIn(out: string): string {
  const name = fs.readdirSync(out).find((d) => d.startsWith("librarian-backup-"));
  if (!name) throw new Error(`no backup dir in ${out}`);
  return path.join(out, name);
}

describe("the-librarian backup / export / restore", () => {
  it("backup writes a bundle with a manifest", async () => {
    await withStore(async (store: LibrarianStore) => {
      seed(store, "one");
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "lib-cli-bk-"));
      const r = runCli(["backup", "--out", out], store);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Backup written");
      expect(fs.existsSync(path.join(backupDirIn(out), "manifest.json"))).toBe(true);
      fs.rmSync(out, { recursive: true, force: true });
    });
  });

  it("export --format json dumps memories + sessions", async () => {
    await withStore(async (store: LibrarianStore) => {
      seed(store, "one");
      const r = runCli(["export", "--format", "json"], store);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).memories.length).toBe(1);
    });
  });

  it("restore refuses without --force", async () => {
    await withStore(async (store: LibrarianStore) => {
      const r = runCli(["restore", "--from", "/nonexistent"], store);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("--force");
    });
  });

  it("restore --force reverts the data dir to the backed-up state", async () => {
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      seed(store, "one"); // 1 memory
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "lib-cli-bk-"));
      runCli(["backup", "--out", out], store);
      const bdir = backupDirIn(out);

      seed(store, "two"); // 2 memories, AFTER the backup

      const r = runCli(["restore", "--from", bdir, "--force"], store); // closes the store
      expect(r.exitCode).toBe(0);

      const reopened = createLibrarianStore({ dataDir });
      try {
        expect(reopened.listAll({}).length).toBe(1); // reverted to the backup state
      } finally {
        reopened.close();
      }
      fs.rmSync(out, { recursive: true, force: true });
    });
  });
});
