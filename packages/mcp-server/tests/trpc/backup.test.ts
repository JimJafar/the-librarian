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

  it("round-trips the schedule + both targets' non-secret config", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      type Config = {
        enabled: boolean;
        intervalMinutes: number;
        target: string;
        retentionKeep: number;
        webhookUrl: string;
        s3: { bucket: string; hasSecretKey: boolean };
        github: { repo: string; hasToken: boolean };
      };
      const before = await trpcGet<Config>(server, "backup.config");
      expect(before.enabled).toBe(false);
      expect(before.s3.bucket).toBe("");
      expect(before.github.hasToken).toBe(false);

      await trpcPost(server, "backup.setConfig", {
        enabled: true,
        intervalMinutes: 30,
        target: "github",
        retentionKeep: 7,
        webhookUrl: "https://hooks.example/x",
        s3: { bucket: "my-bucket", region: "eu-west-1" },
        github: { repo: "me/backups" },
      });

      const after = await trpcGet<Config>(server, "backup.config");
      expect(after.enabled).toBe(true);
      expect(after.intervalMinutes).toBe(30);
      expect(after.target).toBe("github");
      expect(after.retentionKeep).toBe(7);
      expect(after.webhookUrl).toBe("https://hooks.example/x");
      expect(after.s3.bucket).toBe("my-bucket");
      expect(after.github.repo).toBe("me/backups");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("stores cloud secrets write-only — config exposes presence, never the value", async () => {
    const dataDir = makeTempDir();
    // A master key is required to store {secret:true} settings.
    const secretKey = "a".repeat(63) + "b"; // 64 hex chars, non-constant
    const server = await startHttpServer({ dataDir, secretKey });
    try {
      await trpcPost(server, "backup.setConfig", {
        s3: { bucket: "b", accessKey: "AKIA_SECRET_VALUE", secretKey: "SHHH_SECRET_VALUE" },
        github: { repo: "me/bk", token: "ghp_SECRET_TOKEN" },
      });

      // The raw config response must contain the presence flags but none of the values.
      const url = new URL(`${server.url}/trpc/backup.config`);
      const raw = await (
        await fetch(url, { headers: { authorization: `Bearer ${server.token}` } })
      ).text();
      expect(raw).not.toContain("AKIA_SECRET_VALUE");
      expect(raw).not.toContain("SHHH_SECRET_VALUE");
      expect(raw).not.toContain("ghp_SECRET_TOKEN");

      const after = await trpcGet<{
        s3: { hasAccessKey: boolean; hasSecretKey: boolean };
        github: { hasToken: boolean };
      }>(server, "backup.config");
      expect(after.s3.hasAccessKey).toBe(true);
      expect(after.s3.hasSecretKey).toBe(true);
      expect(after.github.hasToken).toBe(true);

      // A blank secret on a later save leaves the stored value intact.
      await trpcPost(server, "backup.setConfig", { s3: { region: "eu-west-1" } });
      const reread = await trpcGet<{ s3: { hasAccessKey: boolean } }>(server, "backup.config");
      expect(reread.s3.hasAccessKey).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("records a run that backup.runs returns", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost(server, "backup.createNow");
      const runs = await trpcGet<{ status: string; trigger: string }[]>(server, "backup.runs");
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("ok");
      expect(runs[0]?.trigger).toBe("manual");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
