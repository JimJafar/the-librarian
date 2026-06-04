import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKUP_RUNS_FILE,
  type LibrarianStore,
  listBackupRuns,
  readBackupConfig,
  runBackup,
  runBackupTick,
  writeBackupConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let store: LibrarianStore;

beforeEach(async () => {
  const { createLibrarianStore } = await import("@librarian/core");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-sched-data-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Configure a GitHub remote via env (no master key needed for an env token) and
// stub the actual push, so the run orchestration is tested without a network hop.
function withRemote(commit: string | null = "abc1234"): void {
  vi.stubEnv("LIBRARIAN_BACKUP_GITHUB_REPO", "o/r");
  vi.stubEnv("LIBRARIAN_BACKUP_GITHUB_TOKEN", "tok");
  vi.spyOn(store, "pushVaultBackup").mockReturnValue(commit);
}

describe("backup config", () => {
  it("defaults to disabled, daily, no webhook", () => {
    expect(readBackupConfig(store, {})).toEqual({
      enabled: false,
      intervalMinutes: 1440,
      webhookUrl: "",
    });
  });

  it("round-trips a written config", () => {
    writeBackupConfig(store, {
      enabled: true,
      intervalMinutes: 60,
      webhookUrl: "https://hooks.example/backup",
    });
    expect(readBackupConfig(store, {})).toEqual({
      enabled: true,
      intervalMinutes: 60,
      webhookUrl: "https://hooks.example/backup",
    });
  });

  it("rejects a non-http webhook URL and a sub-minute interval", () => {
    expect(() => writeBackupConfig(store, { webhookUrl: "ftp://nope" })).toThrow(/http/);
    expect(() => writeBackupConfig(store, { intervalMinutes: 0 })).toThrow();
  });

  it("falls back to the legacy LIBRARIAN_BACKUP_INTERVAL_MS when unconfigured", () => {
    const cfg = readBackupConfig(store, { LIBRARIAN_BACKUP_INTERVAL_MS: "120000" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalMinutes).toBe(2); // 120000ms → 2 min
  });
});

describe("runBackup run-health", () => {
  it("records an ok run that pushed the vault to the remote", async () => {
    withRemote("commit-abc");
    const result = await runBackup(store, { trigger: "manual" });
    expect(result).toMatchObject({ pushed: true, commit: "commit-abc", repo: "o/r" });
    const runs = listBackupRuns(store);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "ok",
      trigger: "manual",
      target: "o/r",
      synced: true,
      bundle: "commit-abc",
    });
  });

  it("records an error run + POSTs the failure webhook when no remote is configured", async () => {
    writeBackupConfig(store, { webhookUrl: "https://hooks.example/x" });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    });

    await expect(runBackup(store, { trigger: "scheduled" })).rejects.toThrow(/no backup remote/);

    const runs = listBackupRuns(store);
    expect(runs[0]).toMatchObject({ status: "error" });
    expect(runs[0].error).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://hooks.example/x");
    expect(posts[0].body).toMatchObject({ event: "backup.failed" });
  });

  it("serializes concurrent runs — all recorded", async () => {
    withRemote();
    await Promise.all([
      runBackup(store, { trigger: "manual" }),
      runBackup(store, { trigger: "manual" }),
      runBackup(store, { trigger: "scheduled" }),
    ]);
    const runs = listBackupRuns(store, 10);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === "ok")).toBe(true);
  });
});

describe("pushVaultBackup", () => {
  it("returns null without pushing when the vault has no commits", async () => {
    const { createLibrarianStore } = await import("@librarian/core");
    const mdDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-empty-vault-"));
    const md = createLibrarianStore({ dataDir: mdDir, backend: "markdown" });
    try {
      // Empty vault → no commits → nothing to push. Must return null WITHOUT
      // attempting a push to the bogus remote (which would otherwise throw).
      expect(
        md.pushVaultBackup({
          remoteUrl: "https://x-access-token@github.com/no/such-repo.git",
          branch: "main",
          token: "unused",
        }),
      ).toBeNull();
    } finally {
      md.close();
      fs.rmSync(mdDir, { recursive: true, force: true });
    }
  });
});

describe("runBackupTick self-gating", () => {
  it("is a no-op when disabled", async () => {
    writeBackupConfig(store, { enabled: false });
    await runBackupTick(store);
    expect(listBackupRuns(store)).toHaveLength(0);
  });

  it("runs once when enabled with no prior run, then skips within the interval", async () => {
    withRemote();
    writeBackupConfig(store, { enabled: true, intervalMinutes: 60 });
    await runBackupTick(store);
    expect(listBackupRuns(store)).toHaveLength(1);
    // A second tick within the interval must not run again.
    await runBackupTick(store);
    expect(listBackupRuns(store)).toHaveLength(1);
  });

  it("reconciles a stale 'running' entry left by a crash, then runs", async () => {
    withRemote();
    writeBackupConfig(store, { enabled: true, intervalMinutes: 60 });
    // A crashed run: 'running' from 2 hours ago (older than the stale TTL), seeded
    // straight into the sidecar runs file (raw persisted state a crash left behind).
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    fs.writeFileSync(
      path.join(dataDir, BACKUP_RUNS_FILE),
      `${JSON.stringify(
        [
          {
            id: "bkp_stale",
            status: "running",
            trigger: "scheduled",
            target: null,
            bundle: null,
            bytes: 0,
            synced: false,
            error: null,
            created_at: old,
            started_at: old,
            completed_at: null,
          },
        ],
        null,
        2,
      )}\n`,
    );

    await runBackupTick(store);

    const runs = listBackupRuns(store);
    const stale = runs.find((r) => r.id === "bkp_stale");
    expect(stale?.status).toBe("error");
    expect(stale?.error).toBe("stale_run_reclaimed");
    // and a fresh backup was made (the reclaimed run's completed_at = its old
    // created_at, so the interval has long since elapsed).
    expect(runs.some((r) => r.status === "ok")).toBe(true);
  });
});
