import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  PRE_RESTORE_BAK,
  RESTORE_FAILED_MARKER,
  RESTORE_MARKER,
  applyPendingRestore,
  stageRestore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-restore-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// A cloned vault is a git repo dir; fabricate one (the real clone is covered by
// cloneVaultBackup's own test).
function makeVault(dir: string, content: string, asRepo = true): void {
  fs.mkdirSync(path.join(dir, "memories"), { recursive: true });
  fs.writeFileSync(path.join(dir, "memories", "a.md"), content);
  if (asRepo) execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
}

function writeMarker(): void {
  fs.writeFileSync(
    path.join(dataDir, RESTORE_MARKER),
    JSON.stringify({ repo: "me/bk", staged_at: new Date().toISOString() }),
  );
}

describe("stageRestore", () => {
  it("throws when no backup remote is configured", async () => {
    const { createLibrarianStore } = await import("@librarian/core");
    const store: LibrarianStore = createLibrarianStore({ dataDir });
    try {
      expect(() => stageRestore(store)).toThrow(/no backup remote/);
    } finally {
      store.close();
    }
  });
});

describe("applyPendingRestore", () => {
  it("no-ops when there is no pending marker", () => {
    expect(applyPendingRestore(dataDir)).toEqual({ applied: false });
  });

  it("swaps the staged vault in and preserves the live vault as a backup", () => {
    makeVault(path.join(dataDir, "vault"), "live\n");
    makeVault(path.join(dataDir, ".restore-staging"), "restored\n");
    writeMarker();

    expect(applyPendingRestore(dataDir)).toEqual({ applied: true, repo: "me/bk" });

    // The vault is now the restored content; the live vault is kept as a backup.
    expect(fs.readFileSync(path.join(dataDir, "vault", "memories", "a.md"), "utf8")).toBe(
      "restored\n",
    );
    expect(fs.readFileSync(path.join(dataDir, PRE_RESTORE_BAK, "memories", "a.md"), "utf8")).toBe(
      "live\n",
    );
    // Marker + staging cleared.
    expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, ".restore-staging"))).toBe(false);
  });

  it("quarantines the marker and leaves the live vault when the staged clone is invalid", () => {
    makeVault(path.join(dataDir, "vault"), "live\n");
    // A staged dir that is NOT a git repo → invalid restore.
    makeVault(path.join(dataDir, ".restore-staging"), "junk\n", false);
    writeMarker();

    const result = applyPendingRestore(dataDir);
    expect(result.applied).toBe(false);
    expect(result.error).toBeTruthy();

    // Live vault untouched; pending marker quarantined (not retried).
    expect(fs.readFileSync(path.join(dataDir, "vault", "memories", "a.md"), "utf8")).toBe("live\n");
    expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, RESTORE_FAILED_MARKER))).toBe(true);
  });

  it("rejects a clone that is a git repo but not a Librarian vault", () => {
    makeVault(path.join(dataDir, "vault"), "live\n");
    // A git repo with no vault dirs (e.g. the wrong repo configured as the remote).
    const staged = path.join(dataDir, ".restore-staging");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "README.md"), "not a vault\n");
    execFileSync("git", ["init"], { cwd: staged, stdio: "ignore" });
    writeMarker();

    expect(applyPendingRestore(dataDir).applied).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, "vault", "memories", "a.md"), "utf8")).toBe("live\n");
    expect(fs.existsSync(path.join(dataDir, RESTORE_FAILED_MARKER))).toBe(true);
  });

  it("restores the LIBRARIAN_VAULT_PATH vault, not <dataDir>/vault", () => {
    const customVault = path.join(dataDir, "custom-vault");
    vi.stubEnv("LIBRARIAN_VAULT_PATH", customVault);
    makeVault(customVault, "live\n");
    makeVault(path.join(dataDir, ".restore-staging"), "restored\n");
    writeMarker();

    expect(applyPendingRestore(dataDir).applied).toBe(true);
    // The configured vault is the one that was swapped, with its prior copy kept.
    expect(fs.readFileSync(path.join(customVault, "memories", "a.md"), "utf8")).toBe("restored\n");
    expect(
      fs.readFileSync(
        path.join(dataDir, "custom-vault.pre-restore.bak", "memories", "a.md"),
        "utf8",
      ),
    ).toBe("live\n");
  });
});
