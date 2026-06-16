// SC-1 (server/CLI hardening): the `the-librarian` CLI must resolve the master key
// so its store can DECRYPT secret settings — specifically the dashboard-saved
// backup token that `restore`'s `resolveBackupRemote` reads.
//
// Why the existing restore tests missed this: they configure the remote via the
// ENV fallback (`LIBRARIAN_BACKUP_GITHUB_*`, plaintext, no decryption). Production
// `restore` against a dashboard-configured deploy hits the ENCRYPTED settings
// path, which a keyless store can't read. This test exercises that path.
//
// GitGuardian-safety: the key is assembled at runtime (no contiguous 64-hex
// literal); the token is a plain placeholder, never a PAT-shaped value.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonSettingsStore, resolveBackupRemote, resolveSecretKey } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCliSecretKey } from "../src/store.js";

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lib-cli-store-"));
}

// Seed an ENCRYPTED, dashboard-style backup remote into <dataDir>/settings.json:
// repo is plaintext, token is an encrypted secret (the shape the dashboard writes).
function seedEncryptedRemote(dataDir: string, keyHex: string): void {
  const settings = createJsonSettingsStore({
    filePath: path.join(dataDir, "settings.json"),
    secretKey: resolveSecretKey(keyHex),
  });
  settings.setSetting("backup.github.repo", "octocat/backup");
  settings.setSetting("backup.github.token", ["placeholder", "pat", "value"].join("-"), {
    secret: true,
  });
}

const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  // resolveBackupRemote falls back to these env vars — clear them so ONLY the
  // encrypted store setting can satisfy it (the entire point of the test).
  for (const k of [
    "LIBRARIAN_SECRET_KEY",
    "LIBRARIAN_BACKUP_GITHUB_REPO",
    "LIBRARIAN_BACKUP_GITHUB_TOKEN",
  ]) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("CLI store key resolution (SC-1)", () => {
  it("resolveCliSecretKey reads the key from <dataDir>/secret.key (env unset)", () => {
    const dataDir = tempDataDir();
    try {
      const keyHex = randomBytes(32).toString("hex");
      fs.writeFileSync(path.join(dataDir, "secret.key"), keyHex, { mode: 0o600 });
      const key = resolveCliSecretKey(dataDir, {});
      expect(key).not.toBeNull();
      expect(key?.toString("hex")).toBe(keyHex);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resolveCliSecretKey prefers env, and returns null (never generates) when absent", () => {
    const dataDir = tempDataDir();
    try {
      const envKey = randomBytes(32).toString("hex");
      expect(resolveCliSecretKey(dataDir, { LIBRARIAN_SECRET_KEY: envKey })?.toString("hex")).toBe(
        envKey,
      );
      // No env, no file → null, and crucially NO secret.key is written.
      expect(resolveCliSecretKey(dataDir, {})).toBeNull();
      expect(fs.existsSync(path.join(dataDir, "secret.key"))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("an empty/whitespace env value falls through to the file (not keyless)", () => {
    const dataDir = tempDataDir();
    try {
      const keyHex = randomBytes(32).toString("hex");
      fs.writeFileSync(path.join(dataDir, "secret.key"), keyHex, { mode: 0o600 });
      // `LIBRARIAN_SECRET_KEY=` exported-but-empty must NOT shadow the on-disk key
      // (a bare `??` would select "" → keyless → the very bug this fixes).
      expect(resolveCliSecretKey(dataDir, { LIBRARIAN_SECRET_KEY: "" })?.toString("hex")).toBe(
        keyHex,
      );
      expect(resolveCliSecretKey(dataDir, { LIBRARIAN_SECRET_KEY: "  " })?.toString("hex")).toBe(
        keyHex,
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("degrades to keyless (null, no throw) on a malformed key — never crashes the CLI", () => {
    const dataDir = tempDataDir();
    try {
      fs.writeFileSync(path.join(dataDir, "secret.key"), "not-a-valid-key", { mode: 0o600 });
      // A corrupt/hand-edited key must not throw out of the bin (AGENTS.md: no stack
      // trace), even for verbs that need no secret.
      expect(resolveCliSecretKey(dataDir, {})).toBeNull();
      expect(resolveCliSecretKey(dataDir, { LIBRARIAN_SECRET_KEY: "also-not-valid" })).toBeNull();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("a KEYED store reads the encrypted backup remote; a KEYLESS one cannot (the bug)", () => {
    const dataDir = tempDataDir();
    try {
      const keyHex = randomBytes(32).toString("hex");
      seedEncryptedRemote(dataDir, keyHex);
      fs.writeFileSync(path.join(dataDir, "secret.key"), keyHex, { mode: 0o600 });
      const filePath = path.join(dataDir, "settings.json");

      // Keyed via resolveCliSecretKey (the fix): the token decrypts → remote resolves.
      const keyed = createJsonSettingsStore({
        filePath,
        secretKey: resolveCliSecretKey(dataDir, {}),
      });
      const remote = resolveBackupRemote(keyed, {});
      expect(remote).not.toBeNull();
      expect(remote?.repo).toBe("octocat/backup");

      // Keyless (the old bin behavior): the token read throws → swallowed → null.
      const keyless = createJsonSettingsStore({ filePath, secretKey: null });
      expect(resolveBackupRemote(keyless, {})).toBeNull();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
