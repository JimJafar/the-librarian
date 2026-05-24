import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BackupTarget,
  createMemoryBackupTarget,
  createS3Target,
  fetchBundle,
  resolveS3SyncConfig,
  syncBundle,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("BackupTarget contract (memory)", () => {
  it("put / get / list round-trips", async () => {
    const t = createMemoryBackupTarget();
    await t.put("a/x.txt", Buffer.from("hello"));
    await t.put("a/y.txt", Buffer.from("world"));
    expect((await t.get("a/x.txt")).toString()).toBe("hello");
    expect(await t.list("a/")).toEqual(["a/x.txt", "a/y.txt"]);
    await expect(t.get("missing")).rejects.toThrow();
  });
});

describe("syncBundle / fetchBundle", () => {
  it("uploads a bundle dir and pulls it back identically", async () => {
    const src = tmp("lib-bundle-src-");
    const bundleDir = path.join(src, "librarian-backup-2026");
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, "manifest.json"), "{}");
    fs.writeFileSync(path.join(bundleDir, "events.jsonl"), "line\n");

    const target = createMemoryBackupTarget();
    const keys = await syncBundle(target, bundleDir);
    expect(keys.sort()).toEqual([
      "librarian-backup-2026/events.jsonl",
      "librarian-backup-2026/manifest.json",
    ]);

    const dest = tmp("lib-bundle-dest-");
    const out = await fetchBundle(target, "librarian-backup-2026", dest);
    expect(fs.readFileSync(path.join(out, "events.jsonl"), "utf8")).toBe("line\n");
    expect(fs.readFileSync(path.join(out, "manifest.json"), "utf8")).toBe("{}");
  });

  it("fetchBundle rejects an object key that escapes the bundle dir", async () => {
    const target = createMemoryBackupTarget();
    await target.put("b/../escape", Buffer.from("x"));
    const dest = tmp("lib-bundle-evil-");
    await expect(fetchBundle(target, "b", dest)).rejects.toThrow(/unsafe object key/);
  });
});

describe("resolveS3SyncConfig", () => {
  const noSettings = { getSetting: () => null };

  it("returns null when not configured", () => {
    expect(resolveS3SyncConfig(noSettings, {})).toBeNull();
  });

  it("resolves from env", () => {
    const config = resolveS3SyncConfig(noSettings, {
      LIBRARIAN_BACKUP_S3_BUCKET: "b",
      LIBRARIAN_BACKUP_S3_ACCESS_KEY: "ak",
      LIBRARIAN_BACKUP_S3_SECRET_KEY: "sk",
      LIBRARIAN_BACKUP_S3_ENDPOINT: "https://r2.example",
    });
    expect(config).toEqual({
      bucket: "b",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      endpoint: "https://r2.example",
    });
  });

  it("prefers settings over env and tolerates a secret read that throws", () => {
    const store = {
      getSetting: (key: string) => {
        if (key === "backup.s3.secret_key") throw new Error("no master key");
        if (key === "backup.s3.bucket") return "from-settings";
        return null;
      },
    };
    const config = resolveS3SyncConfig(store, {
      LIBRARIAN_BACKUP_S3_BUCKET: "from-env",
      LIBRARIAN_BACKUP_S3_ACCESS_KEY: "ak",
      LIBRARIAN_BACKUP_S3_SECRET_KEY: "sk", // settings read threw → env used
    });
    expect(config?.bucket).toBe("from-settings");
    expect(config?.secretAccessKey).toBe("sk");
  });
});

describe("createS3Target", () => {
  it("fails with a clear message when @aws-sdk/client-s3 is not installed", async () => {
    // The package is intentionally NOT a dependency, so the lazy import fails here.
    await expect(
      createS3Target({
        bucket: "b",
        accessKeyId: "ak",
        secretAccessKey: "sk",
      }) as Promise<BackupTarget>,
    ).rejects.toThrow(/@aws-sdk\/client-s3 is not installed/);
  });
});
