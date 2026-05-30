// Backup admin tRPC tests — spawns the real HTTP bin and exercises admin gating,
// createNow → list, and a plain config round-trip. (The secret-credential path is
// covered by core's settings-store; it needs LIBRARIAN_SECRET_KEY in the server env.)

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}
interface TrpcErr {
  error: unknown;
}
interface ServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGet<T>(server: ServerHandle, p: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.url}/trpc/${p}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const res = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await res.json()) as TrpcOk<T> | TrpcErr;
  if (res.status >= 400 || "error" in json) throw new Error(`GET ${p}: ${JSON.stringify(json)}`);
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, p: string, input?: unknown): Promise<T> {
  const res = await fetch(`${server.url}/trpc/${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await res.json()) as TrpcOk<T> | TrpcErr;
  if (res.status >= 400 || "error" in json) throw new Error(`POST ${p}: ${JSON.stringify(json)}`);
  return (json as TrpcOk<T>).result.data;
}

describe("tRPC backup surface", () => {
  it("requires admin auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/trpc/backup.list`); // no Authorization
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("createNow writes a bundle that then shows up in list", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const created = await trpcPost<{ files: number; synced: boolean }>(
        server,
        "backup.createNow",
      );
      expect(created.files).toBeGreaterThan(0);
      expect(created.synced).toBe(false); // no cloud sync configured

      const list = await trpcGet<{ name: string }[]>(server, "backup.list");
      expect(list.length).toBe(1);
      expect(list[0]?.name).toMatch(/^librarian-backup-/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("stageRestore validates a bundle and writes the pending-restore marker", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost(server, "backup.createNow");
      const list = await trpcGet<{ name: string }[]>(server, "backup.list");
      const bundle = list[0]?.name as string;

      const staged = await trpcPost<{ staged: string; restartRequired: boolean }>(
        server,
        "backup.stageRestore",
        { bundle },
      );
      expect(staged).toEqual({ staged: bundle, restartRequired: true });
      expect(fs.existsSync(path.join(dataDir, "restore.pending.json"))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("round-trips a plain (non-secret) sync config", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const before = await trpcGet<{ bucket: string; hasSecretKey: boolean }>(
        server,
        "backup.config",
      );
      expect(before.bucket).toBe("");
      expect(before.hasSecretKey).toBe(false);

      await trpcPost(server, "backup.setConfig", { bucket: "my-bucket", region: "eu-west-1" });

      const after = await trpcGet<{ bucket: string; region: string }>(server, "backup.config");
      expect(after.bucket).toBe("my-bucket");
      expect(after.region).toBe("eu-west-1");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
