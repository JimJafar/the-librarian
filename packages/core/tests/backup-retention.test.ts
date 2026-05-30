import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMemoryBackupTarget, pruneLocal, pruneTarget } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-retention-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeBundle(name: string, withManifest = true) {
  const bundleDir = path.join(dir, name);
  fs.mkdirSync(bundleDir);
  fs.writeFileSync(path.join(bundleDir, "librarian.sqlite.gz"), "x");
  if (withManifest) fs.writeFileSync(path.join(bundleDir, "manifest.json"), "{}");
}

const bundleName = (i: number) => `librarian-backup-${String(i).padStart(2, "0")}`;

describe("pruneLocal", () => {
  it("keeps the newest N bundles and removes the rest (16 → keep 14)", () => {
    for (let i = 0; i < 16; i++) makeBundle(bundleName(i));
    const removed = pruneLocal(dir, 14);

    expect(removed.sort()).toEqual([bundleName(0), bundleName(1)]); // the two oldest
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toHaveLength(14);
    expect(remaining[0]).toBe(bundleName(2));
    expect(remaining.at(-1)).toBe(bundleName(15));
  });

  it("is a no-op when keep >= the bundle count", () => {
    for (let i = 0; i < 5; i++) makeBundle(bundleName(i));
    expect(pruneLocal(dir, 14)).toEqual([]);
    expect(fs.readdirSync(dir)).toHaveLength(5);
  });

  it("never prunes the newest (possibly in-progress) bundle", () => {
    for (let i = 0; i < 14; i++) makeBundle(bundleName(i));
    makeBundle(bundleName(99), /* withManifest */ false); // newest, still being written
    pruneLocal(dir, 14);
    // 15 bundles, keep 14 → only the single oldest goes; the manifest-less newest stays.
    expect(fs.existsSync(path.join(dir, bundleName(99)))).toBe(true);
    expect(fs.existsSync(path.join(dir, bundleName(0)))).toBe(false);
  });

  it("sorts real createBackup-style timestamp names chronologically", () => {
    // Names exactly as createBackup produces them: librarian-backup-<ISO with :/. → ->.
    // This guards the load-bearing "lexical == chronological" invariant against a
    // future change to the bundle-naming format.
    const names = Array.from({ length: 5 }, (_, i) => {
      const iso = new Date(Date.UTC(2026, 4, 30, 0, 0, i)).toISOString().replace(/[:.]/g, "-");
      return `librarian-backup-${iso}`;
    });
    for (const name of names) makeBundle(name);

    const removed = pruneLocal(dir, 3);
    expect(removed).toEqual([names[0], names[1]]); // the two oldest, in order
    expect(fs.existsSync(path.join(dir, names[0]))).toBe(false);
    expect(fs.existsSync(path.join(dir, names[4]))).toBe(true);
  });

  it("ignores non-bundle dirs and a missing dir", () => {
    fs.mkdirSync(path.join(dir, "not-a-backup"));
    for (let i = 0; i < 16; i++) makeBundle(bundleName(i));
    pruneLocal(dir, 14);
    expect(fs.existsSync(path.join(dir, "not-a-backup"))).toBe(true);
    expect(pruneLocal(path.join(dir, "does-not-exist"), 14)).toEqual([]);
  });
});

describe("pruneTarget", () => {
  it("keeps the newest N bundles on a cloud target (16 → keep 14)", async () => {
    const target = createMemoryBackupTarget();
    for (let i = 0; i < 16; i++) {
      await target.put(`${bundleName(i)}/librarian.sqlite.gz`, Buffer.from("x"));
      await target.put(`${bundleName(i)}/manifest.json`, Buffer.from("{}"));
    }

    const removed = await pruneTarget(target, 14);
    expect(removed.sort()).toEqual([bundleName(0), bundleName(1)]);

    const remainingBundles = new Set((await target.list()).map((k) => k.split("/")[0]));
    expect(remainingBundles.size).toBe(14);
    expect(remainingBundles.has(bundleName(0))).toBe(false);
    expect(remainingBundles.has(bundleName(15))).toBe(true);
  });

  it("is a no-op when keep >= the bundle count", async () => {
    const target = createMemoryBackupTarget();
    await target.put(`${bundleName(0)}/f`, Buffer.from("x"));
    expect(await pruneTarget(target, 14)).toEqual([]);
  });
});
