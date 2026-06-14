// `the-librarian restore` — clone the configured backup remote into the data
// dir's vault and place the operator-supplied master key so the server can
// decrypt restored secrets (the key is excluded from backups, spec §6/§7).
//
// The real clone reaches github.com, so the clone is an injected seam here; the
// tests pin the guards (no remote, missing/malformed key, clobber refusal) and
// that a happy-path restore clones, writes secret.key (0600), and reindexes.
//
// GitGuardian-safety: any 64-hex key is assembled from sub-threshold parts at
// runtime — the committed source never contains a contiguous 64-hex run.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type LibrarianStore, resolveSecretKey } from "@librarian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { restoreCommand } from "../src/commands/restore.js";
import { runCli } from "../src/runtime.js";

// A well-formed 64-hex key, assembled at runtime (never a contiguous literal).
function freshKeyHex(): string {
  return randomBytes(32).toString("hex");
}

const VAULT_DIRS = ["memories", "inbox", "references", "handoffs"];

// A stub clone that materialises a minimal Librarian-vault-shaped dir at `dest`,
// mirroring what `git clone` would leave behind — so the post-clone reindex has
// something to walk and the test can assert the clone target.
function fakeClone(opts: { remoteUrl: string; branch: string; token: string; dest: string }) {
  fs.mkdirSync(opts.dest, { recursive: true });
  fs.mkdirSync(path.join(opts.dest, ".git"), { recursive: true });
  for (const d of VAULT_DIRS) fs.mkdirSync(path.join(opts.dest, d), { recursive: true });
  fs.writeFileSync(path.join(opts.dest, "memories", "seed.md"), "# seed\n");
}

// Configure a backup remote via the env fallback (no master key needed), and
// restore the prior env afterwards.
const SAVED_ENV: Record<string, string | undefined> = {};
function withBackupRemote() {
  for (const k of ["LIBRARIAN_BACKUP_GITHUB_REPO", "LIBRARIAN_BACKUP_GITHUB_TOKEN"]) {
    SAVED_ENV[k] = process.env[k];
  }
  process.env.LIBRARIAN_BACKUP_GITHUB_REPO = "octocat/backup";
  // Assembled from parts so the committed source carries no real-looking PAT
  // (the value only needs to be a non-empty placeholder for resolveBackupRemote).
  process.env.LIBRARIAN_BACKUP_GITHUB_TOKEN = ["fake", "backup", "token"].join("-");
}
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function vaultPath(dataDir: string): string {
  return path.join(dataDir, "vault");
}

describe("the-librarian restore", () => {
  it("clones, writes secret.key (0600) with the supplied key, and reindexes", async () => {
    withBackupRemote();
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const supplied = freshKeyHex();
      const clone = vi.fn(fakeClone);
      const reindex = vi.spyOn(store, "reindex");

      const r = restoreCommand(store, [], { "secret-key": supplied }, { clone });

      expect(r.exitCode).toBe(0);
      // Cloned into the data dir's vault from the configured remote.
      expect(clone).toHaveBeenCalledTimes(1);
      const opts = clone.mock.calls[0]![0];
      expect(opts.dest).toBe(vaultPath(dataDir));
      expect(opts.remoteUrl).toContain("octocat/backup");
      // secret.key written with the supplied key, owner-only.
      const keyFile = path.join(dataDir, "secret.key");
      expect(fs.readFileSync(keyFile, "utf8").trim()).toBe(
        resolveSecretKey(supplied).toString("hex"),
      );
      expect(fs.statSync(keyFile).mode & 0o077).toBe(0);
      // Recall index rebuilt from the restored vault.
      expect(reindex).toHaveBeenCalledTimes(1);
      // The placed key decrypts secrets: a store opened against this data dir +
      // key can read the canonical key back.
      expect(
        resolveSecretKey(fs.readFileSync(keyFile, "utf8")).equals(resolveSecretKey(supplied)),
      ).toBe(true);
    });
  });

  it("refuses with no backup remote configured — no clone, no key written", async () => {
    // No withBackupRemote(): ensure the env fallback is absent for this test.
    delete process.env.LIBRARIAN_BACKUP_GITHUB_REPO;
    delete process.env.LIBRARIAN_BACKUP_GITHUB_TOKEN;
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const clone = vi.fn(fakeClone);
      const r = restoreCommand(store, [], { "secret-key": freshKeyHex() }, { clone });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/no backup remote/i);
      expect(clone).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(dataDir, "secret.key"))).toBe(false);
    });
  });

  it("errors when --secret-key is absent and non-interactive — names the backup exclusion, no clone", async () => {
    withBackupRemote();
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const clone = vi.fn(fakeClone);
      const r = restoreCommand(store, [], {}, { clone, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/secret key/i);
      expect(r.stdout).toMatch(/excluded from backups/i);
      // Nothing clobbered: no clone, no restored content, no key written.
      expect(clone).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(vaultPath(dataDir), "memories", "seed.md"))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "secret.key"))).toBe(false);
    });
  });

  it("prompts for the secret key when absent and interactive", async () => {
    withBackupRemote();
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const supplied = freshKeyHex();
      const clone = vi.fn(fakeClone);
      const r = restoreCommand(
        store,
        [],
        {},
        { clone, interactive: true, promptSecretKey: () => supplied },
      );
      expect(r.exitCode).toBe(0);
      expect(clone).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(path.join(dataDir, "secret.key"), "utf8").trim()).toBe(
        resolveSecretKey(supplied).toString("hex"),
      );
    });
  });

  it("rejects a malformed --secret-key — teaching error, nothing written", async () => {
    withBackupRemote();
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const clone = vi.fn(fakeClone);
      const r = restoreCommand(store, [], { "secret-key": "tooshort" }, { clone });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/secret key|32 bytes/i);
      expect(clone).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(vaultPath(dataDir), "memories", "seed.md"))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "secret.key"))).toBe(false);
    });
  });

  it("refuses a non-empty vault without --force, then proceeds with --force", async () => {
    withBackupRemote();
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      // Pre-existing non-empty vault (existing memories).
      const vault = vaultPath(dataDir);
      fs.mkdirSync(path.join(vault, "memories"), { recursive: true });
      fs.writeFileSync(path.join(vault, "memories", "existing.md"), "# keep me\n");

      const supplied = freshKeyHex();
      const clone = vi.fn(fakeClone);

      const refused = restoreCommand(store, [], { "secret-key": supplied }, { clone });
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toMatch(/--force/);
      expect(clone).not.toHaveBeenCalled();
      // The existing vault is untouched.
      expect(fs.existsSync(path.join(vault, "memories", "existing.md"))).toBe(true);

      const forced = restoreCommand(store, [], { "secret-key": supplied, force: true }, { clone });
      expect(forced.exitCode).toBe(0);
      expect(clone).toHaveBeenCalledTimes(1);
      // The clobbered vault is the restored one (the stub's seed, not the old file).
      expect(fs.existsSync(path.join(vault, "memories", "existing.md"))).toBe(false);
      expect(fs.existsSync(path.join(vault, "memories", "seed.md"))).toBe(true);
    });
  });

  it("refuses to overwrite a differing existing secret.key without --force", async () => {
    withBackupRemote();
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const existing = freshKeyHex();
      fs.writeFileSync(path.join(dataDir, "secret.key"), existing, { mode: 0o600 });

      const supplied = freshKeyHex();
      const clone = vi.fn(fakeClone);
      const r = restoreCommand(store, [], { "secret-key": supplied }, { clone });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/secret\.key|--force/i);
      expect(clone).not.toHaveBeenCalled();
      // The existing key is intact.
      expect(fs.readFileSync(path.join(dataDir, "secret.key"), "utf8").trim()).toBe(existing);
    });
  });

  it("is reachable through the CLI dispatcher (runtime wiring)", async () => {
    // No remote configured → the dispatched command hits the no-remote guard,
    // proving `restore` is wired into runCli (not an unknown command).
    delete process.env.LIBRARIAN_BACKUP_GITHUB_REPO;
    delete process.env.LIBRARIAN_BACKUP_GITHUB_TOKEN;
    await withStore(async (store: LibrarianStore) => {
      const r = runCli(["restore", "--secret-key", freshKeyHex()], store);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/no backup remote/i);
      expect(r.stdout).not.toMatch(/unknown command/i);
    });
  });
});
