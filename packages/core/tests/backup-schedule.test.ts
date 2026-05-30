import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  listBackupRuns,
  readBackupConfig,
  runBackup,
  runBackupTick,
  writeBackupConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let destDir: string;
let store: LibrarianStore;

beforeEach(async () => {
  const { createLibrarianStore } = await import("@librarian/core");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-sched-data-"));
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-sched-dest-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(destDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("backup config", () => {
  it("defaults to disabled, daily, local, keep 14, no webhook", () => {
    const cfg = readBackupConfig(store, {});
    expect(cfg).toEqual({
      enabled: false,
      intervalMinutes: 1440,
      target: "local",
      retentionKeep: 14,
      webhookUrl: "",
    });
  });

  it("round-trips a written config", () => {
    writeBackupConfig(store, {
      enabled: true,
      intervalMinutes: 60,
      target: "github",
      retentionKeep: 7,
      webhookUrl: "https://hooks.example/backup",
    });
    expect(readBackupConfig(store, {})).toEqual({
      enabled: true,
      intervalMinutes: 60,
      target: "github",
      retentionKeep: 7,
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

  it("auto-detects the target from env cloud creds when not explicitly set", () => {
    const cfg = readBackupConfig(store, {
      LIBRARIAN_BACKUP_GITHUB_REPO: "o/r",
      LIBRARIAN_BACKUP_GITHUB_TOKEN: "tok",
    });
    expect(cfg.target).toBe("github");
  });
});

describe("runBackup run-health", () => {
  it("records an ok run (target local) for a local-only backup", async () => {
    await runBackup(store, { destDir, sync: false, trigger: "manual" });
    const runs = listBackupRuns(store);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "ok",
      trigger: "manual",
      target: "local",
      synced: false,
    });
    expect(runs[0].bytes).toBeGreaterThan(0);
  });

  it("records an error run and POSTs the failure webhook", async () => {
    // target=s3 with creds present (env) but no @aws-sdk installed → the S3 target
    // construction throws, which is a deterministic, network-free failure.
    vi.stubEnv("LIBRARIAN_BACKUP_S3_BUCKET", "b");
    vi.stubEnv("LIBRARIAN_BACKUP_S3_ACCESS_KEY", "ak");
    vi.stubEnv("LIBRARIAN_BACKUP_S3_SECRET_KEY", "sk");
    writeBackupConfig(store, { target: "s3", webhookUrl: "https://hooks.example/x" });
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    });

    await expect(runBackup(store, { destDir, trigger: "scheduled" })).rejects.toThrow();

    const runs = listBackupRuns(store);
    expect(runs[0]).toMatchObject({ status: "error" });
    expect(runs[0].error).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://hooks.example/x");
    expect(posts[0].body).toMatchObject({ event: "backup.failed", target: "s3" });
  });

  it("serializes concurrent runs — all succeed with distinct bundles", async () => {
    const results = await Promise.all([
      runBackup(store, { destDir, sync: false, trigger: "manual" }),
      runBackup(store, { destDir, sync: false, trigger: "manual" }),
      runBackup(store, { destDir, sync: false, trigger: "scheduled" }),
    ]);
    expect(new Set(results.map((r) => r.dir)).size).toBe(3); // distinct dirs, no collision
    const runs = listBackupRuns(store, 10);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === "ok")).toBe(true);
  });
});

describe("runBackupTick self-gating", () => {
  it("is a no-op when disabled", async () => {
    writeBackupConfig(store, { enabled: false });
    await runBackupTick(store, { destDir });
    expect(listBackupRuns(store)).toHaveLength(0);
  });

  it("runs once when enabled with no prior run, then skips within the interval", async () => {
    writeBackupConfig(store, { enabled: true, intervalMinutes: 60, target: "local" });
    await runBackupTick(store, { destDir });
    expect(listBackupRuns(store)).toHaveLength(1);
    // A second tick within the interval must not run again.
    await runBackupTick(store, { destDir });
    expect(listBackupRuns(store)).toHaveLength(1);
  });

  it("reconciles a stale 'running' row left by a crash, then runs", async () => {
    writeBackupConfig(store, { enabled: true, intervalMinutes: 60, target: "local" });
    // A crashed run: 'running' from 2 hours ago (older than the stale TTL).
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    store.db
      .prepare(
        `INSERT INTO backup_runs (id, status, trigger, bytes, synced, created_at, started_at)
         VALUES ('bkp_stale', 'running', 'scheduled', 0, 0, ?, ?)`,
      )
      .run(old, old);

    await runBackupTick(store, { destDir });

    const runs = listBackupRuns(store);
    const stale = runs.find((r) => r.id === "bkp_stale");
    expect(stale?.status).toBe("error");
    expect(stale?.error).toBe("stale_run_reclaimed");
    // and a fresh backup was made (the reclaimed run's completed_at = its old
    // created_at, so the interval has long since elapsed).
    expect(runs.some((r) => r.status === "ok")).toBe(true);
  });
});
