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
  const url = new URL(`${server.trpcUrl}/trpc/${p}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const res = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await res.json()) as TrpcOk<T> | TrpcErr;
  if (res.status >= 400 || "error" in json) throw new Error(`GET ${p}: ${JSON.stringify(json)}`);
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, p: string, input?: unknown): Promise<T> {
  const res = await fetch(`${server.trpcUrl}/trpc/${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await res.json()) as TrpcOk<T> | TrpcErr;
  if (res.status >= 400 || "error" in json) throw new Error(`POST ${p}: ${JSON.stringify(json)}`);
  return (json as TrpcOk<T>).result.data;
}

describe("tRPC backup surface", () => {
  it("is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // The backup admin surface is off the network (ADR 0008 P1/P3): /trpc 404s
      // on the public port even with an agent bearer.
      const res = await fetch(`${server.url}/trpc/backup.config`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(res.status).toBe(404);
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
      const url = new URL(`${server.trpcUrl}/trpc/backup.config`);
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

  it("canRestore reflects a configured remote, NOT prior run history (SC-4)", async () => {
    const dataDir = makeTempDir();
    const secretKey = "c".repeat(63) + "d"; // 64 hex chars, non-constant
    const server = await startHttpServer({ dataDir, secretKey });
    try {
      type Cfg = { canRestore: boolean };
      // Fresh deploy: no remote configured → nothing to restore from.
      expect((await trpcGet<Cfg>(server, "backup.config")).canRestore).toBe(false);

      // Configure a remote (repo + token) but run NO backup.
      await trpcPost(server, "backup.setConfig", {
        github: { repo: "me/backups", token: ["placeholder", "pat", "value"].join("-") },
      });

      // canRestore flips true purely from the resolvable remote — the dashboard
      // Restore button must enable on a fresh deployment (e.g. a host migration),
      // which the old `runs.some(ok)` gate made impossible.
      expect((await trpcGet<Cfg>(server, "backup.config")).canRestore).toBe(true);
      // …and there are genuinely zero runs, so the old gate would have been false.
      expect(await trpcGet<unknown[]>(server, "backup.runs")).toEqual([]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects a malformed GitHub repo with a teaching error, but allows owner/repo and unset", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // A bare repo name (no owner) would fail deep in the git push with a confusing
      // message — reject it here with a message that teaches the expected shape and
      // echoes the bad value (but never any token).
      const rawRes = await fetch(`${server.trpcUrl}/trpc/backup.setConfig`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ github: { repo: "hello-world" } }),
      });
      expect(rawRes.status).toBeGreaterThanOrEqual(400);
      const body = await rawRes.text();
      expect(body).toContain("owner/repo");
      expect(body).toContain("octocat/hello-world");
      expect(body).toContain("hello-world");

      // A full URL is also rejected (the remote is built from owner/repo).
      await expect(
        trpcPost(server, "backup.setConfig", {
          github: { repo: "https://github.com/me/backups.git" },
        }),
      ).rejects.toThrow();

      // A well-formed owner/repo passes, and an unset repo stays allowed (optional).
      await trpcPost(server, "backup.setConfig", { github: { repo: "octocat/hello-world" } });
      await trpcPost(server, "backup.setConfig", { enabled: true });

      const after = await trpcGet<{ github: { repo: string }; enabled: boolean }>(
        server,
        "backup.config",
      );
      expect(after.github.repo).toBe("octocat/hello-world");
      expect(after.enabled).toBe(true);
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
