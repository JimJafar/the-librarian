// Backup admin tRPC tests — spawns the real HTTP bin and exercises admin gating,
// the config round-trip (schedule + GitHub remote), write-only token storage, and
// that a remote-less createNow surfaces an error run. (The happy push targets
// github.com, which a test can't reach; the push itself is covered in core.)

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
      const res = await fetch(`${server.url}/trpc/backup.config`); // no Authorization
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("round-trips the schedule + GitHub remote (non-secret) config", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      type Config = {
        enabled: boolean;
        intervalMinutes: number;
        webhookUrl: string;
        github: { repo: string; hasToken: boolean };
      };
      const before = await trpcGet<Config>(server, "backup.config");
      expect(before.enabled).toBe(false);
      expect(before.github.repo).toBe("");
      expect(before.github.hasToken).toBe(false);

      await trpcPost(server, "backup.setConfig", {
        enabled: true,
        intervalMinutes: 30,
        webhookUrl: "https://hooks.example/x",
        github: { repo: "me/backups" },
      });

      const after = await trpcGet<Config>(server, "backup.config");
      expect(after.enabled).toBe(true);
      expect(after.intervalMinutes).toBe(30);
      expect(after.webhookUrl).toBe("https://hooks.example/x");
      expect(after.github.repo).toBe("me/backups");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("stores the GitHub token write-only — config exposes presence, never the value", async () => {
    const dataDir = makeTempDir();
    // A master key is required to store {secret:true} settings.
    const secretKey = "a".repeat(63) + "b"; // 64 hex chars, non-constant
    const server = await startHttpServer({ dataDir, secretKey });
    try {
      await trpcPost(server, "backup.setConfig", {
        github: { repo: "me/bk", token: "ghp_SECRET_TOKEN" },
      });

      // The raw config response must contain the presence flag but not the token.
      const url = new URL(`${server.url}/trpc/backup.config`);
      const raw = await (
        await fetch(url, { headers: { authorization: `Bearer ${server.token}` } })
      ).text();
      expect(raw).not.toContain("ghp_SECRET_TOKEN");

      const after = await trpcGet<{ github: { hasToken: boolean } }>(server, "backup.config");
      expect(after.github.hasToken).toBe(true);

      // A blank token on a later save leaves the stored value intact.
      await trpcPost(server, "backup.setConfig", { github: { repo: "me/bk2" } });
      const reread = await trpcGet<{ github: { hasToken: boolean; repo: string } }>(
        server,
        "backup.config",
      );
      expect(reread.github.hasToken).toBe(true);
      expect(reread.github.repo).toBe("me/bk2");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("createNow without a remote surfaces an error run", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // No GitHub remote configured → the push has nowhere to go → the run errors.
      await expect(trpcPost(server, "backup.createNow")).rejects.toThrow();
      const runs = await trpcGet<{ status: string; trigger: string }[]>(server, "backup.runs");
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("error");
      expect(runs[0]?.trigger).toBe("manual");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
