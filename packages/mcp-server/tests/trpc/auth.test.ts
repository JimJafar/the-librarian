// D2.1: the `auth` admin tRPC router. Spawns the real HTTP bin (which, via D0,
// auto-generates a master key into the data dir, so ctx.secretKey is present and
// AUTH_SECRET derives). Exercises admin gating, the enable admin-token check, and
// verifyPassword lockout.

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

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.trpcUrl}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc POST ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

interface AuthConfigData {
  enabled: boolean;
  methods: string[];
  password: { username: string } | null;
  authSecret: string | null;
}
interface OwnerAuthResultData {
  ok: boolean;
  locked: boolean;
  lockedUntil: string | null;
}

const PW = "correct-horse-battery";

describe("tRPC auth surface (D2.1)", () => {
  it("grants admin on the trusted internal listener with NO bearer (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // The internal listener is the gate (loopback / internal docker network,
      // never published — its network unreachability from outside is proved in
      // listeners.test). So an admin procedure resolves WITHOUT any bearer.
      const noAuth = await fetch(`${server.trpcUrl}/trpc/auth.config`); // no Authorization
      expect(noAuth.status).toBe(200);

      // An agent bearer is simply ignored here — the surface, not the token,
      // decides the role, so it is STILL admin (never downgraded to anonymous).
      const withAgent = await fetch(`${server.trpcUrl}/trpc/auth.config`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(withAgent.status).toBe(200);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("config reports an empty config with a derived AUTH_SECRET", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const cfg = await trpcGet<AuthConfigData>(server, "auth.config");
      expect(cfg.enabled).toBe(false);
      expect(cfg.methods).toEqual([]);
      expect(cfg.authSecret).toMatch(/^[0-9a-f]{64}$/); // D0 generated the master key
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("enable rejects a wrong admin token but accepts the configured one", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost(server, "auth.setPassword", { username: "owner", password: PW });

      await expect(trpcPost(server, "auth.enable", { adminToken: "wrong" })).rejects.toThrow();
      expect((await trpcGet<AuthConfigData>(server, "auth.config")).enabled).toBe(false);

      await trpcPost(server, "auth.enable", { adminToken: server.token });
      expect((await trpcGet<AuthConfigData>(server, "auth.config")).enabled).toBe(true);

      await trpcPost(server, "auth.disable");
      expect((await trpcGet<AuthConfigData>(server, "auth.config")).enabled).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("verifyPassword honors lockout after repeated failures", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost(server, "auth.setPassword", { username: "owner", password: PW });

      let last: OwnerAuthResultData | undefined;
      for (let i = 0; i < 5; i++) {
        last = await trpcPost<OwnerAuthResultData>(server, "auth.verifyPassword", {
          username: "owner",
          password: "wrong-password-x",
        });
      }
      expect(last?.locked).toBe(true);

      // A correct password is still refused while locked.
      const duringLock = await trpcPost<OwnerAuthResultData>(server, "auth.verifyPassword", {
        username: "owner",
        password: PW,
      });
      expect(duringLock.ok).toBe(false);
      expect(duringLock.locked).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
