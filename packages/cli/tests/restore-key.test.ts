// D0.6 — after a cross-host restore the encrypted secrets are present but the
// master key is not (backups are key-free). The CLI must resolve the key from
// --secret-key / env / a TTY prompt, verify it decrypts the restored secrets, and
// persist it so the next server boot can read it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createBackup,
  createLibrarianStore,
  resolveSecretKey,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";
import { restoreCommand } from "../src/commands/restore.js";

const SRC_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const WRONG_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function backupDirIn(out: string): string {
  const name = fs.readdirSync(out).find((d) => d.startsWith("librarian-backup-"));
  if (!name) throw new Error(`no backup dir in ${out}`);
  return path.join(out, name);
}

// Build a backup that contains an encrypted secret, then a fresh target data dir
// (the "new host") and return what restoreCommand needs.
function backupWithSecret(): { backupDir: string; targetDir: string; target: LibrarianStore } {
  const srcDir = tmp("lib-src-");
  const src = createLibrarianStore({ dataDir: srcDir, secretKey: resolveSecretKey(SRC_KEY) });
  src.setSetting("curator:llm_token", "sk-super-secret", { secret: true });
  const out = tmp("lib-out-");
  createBackup(src, { destDir: out });
  src.close();

  const targetDir = tmp("lib-tgt-");
  const target = createLibrarianStore({ dataDir: targetDir }); // no key, like the CLI bin
  return { backupDir: backupDirIn(out), targetDir, target };
}

describe("restore master-key recovery (D0.6)", () => {
  it("decrypts restored secrets with a correct --secret-key and persists it 0600", () => {
    const { backupDir, targetDir, target } = backupWithSecret();
    const r = restoreCommand(
      target,
      [],
      { from: backupDir, force: true, "secret-key": SRC_KEY },
      { env: {}, promptSecretKey: () => null },
    );
    expect(r.exitCode).toBe(0);
    const keyFile = path.join(targetDir, "secret.key");
    expect(fs.readFileSync(keyFile, "utf8").trim()).toBe(SRC_KEY);
    expect(fs.statSync(keyFile).mode & 0o077).toBe(0);
  });

  it("prompts on a TTY when no flag/env key is given, then decrypts and persists", () => {
    const { backupDir, targetDir, target } = backupWithSecret();
    let prompted = 0;
    const r = restoreCommand(
      target,
      [],
      { from: backupDir, force: true },
      {
        env: {},
        promptSecretKey: () => {
          prompted++;
          return SRC_KEY;
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(prompted).toBe(1);
    expect(fs.existsSync(path.join(targetDir, "secret.key"))).toBe(true);
  });

  it("errors clearly on a wrong --secret-key and never persists it", () => {
    const { backupDir, targetDir, target } = backupWithSecret();
    const r = restoreCommand(
      target,
      [],
      { from: backupDir, force: true, "secret-key": WRONG_KEY },
      { env: {}, promptSecretKey: () => null },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/does not decrypt|wrong key/i);
    expect(fs.existsSync(path.join(targetDir, "secret.key"))).toBe(false);
  });

  it("gives an actionable error when non-interactive with no key for encrypted secrets", () => {
    const { backupDir, targetDir, target } = backupWithSecret();
    const r = restoreCommand(
      target,
      [],
      { from: backupDir, force: true },
      { env: {}, promptSecretKey: () => null }, // no TTY
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/--secret-key/);
    expect(r.stdout).not.toMatch(/at .*\n\s+at /); // not a raw stack trace
    expect(fs.existsSync(path.join(targetDir, "secret.key"))).toBe(false);
  });

  it("restores without any key handling when the backup has no secrets", () => {
    const srcDir = tmp("lib-src-");
    const src = createLibrarianStore({ dataDir: srcDir });
    src.createMemory({
      agent_id: "claude",
      title: "no secrets here",
      body: "b",
      category: "projects",
      visibility: "common",
      scope: "project",
      project_key: "the-librarian",
      priority: "normal",
      confidence: "working",
    });
    const out = tmp("lib-out-");
    createBackup(src, { destDir: out });
    src.close();
    const targetDir = tmp("lib-tgt-");
    const target = createLibrarianStore({ dataDir: targetDir });

    const r = restoreCommand(
      target,
      [],
      { from: backupDirIn(out), force: true },
      {
        env: {},
        promptSecretKey: () => {
          throw new Error("should not prompt when there are no secrets");
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(targetDir, "secret.key"))).toBe(false);
  });
});
