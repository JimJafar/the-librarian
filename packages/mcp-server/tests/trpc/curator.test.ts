// Memory-curator admin tRPC procedure tests (§7.1/§13). Spawns the real HTTP bin
// and exercises the cockpit surface end to end: admin gating, config read/update
// round-trip (no token — the encrypted-token path is covered by core), run
// observability, and run-now (disabled config → no run).

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
  const url = new URL(`${server.url}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.url}/trpc/${path}`, {
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

interface CuratorConfig {
  enabled: boolean;
  llm: { provider: string; endpoint: string; model: string };
  hasToken: boolean;
  defaultAutoApply: string;
  isOperational: boolean;
}

describe("tRPC curator surface", () => {
  it("requires admin auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/curator.config`); // no Authorization
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects an agent-role token on run-now (§12 — no consumer-reachable trigger)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir }); // agentToken defaults to "agent-token"
    try {
      const response = await fetch(`${server.url}/trpc/curator.runNow`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
      });
      expect(response.status).toBeGreaterThanOrEqual(400); // agent role is not admin
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("reads safe defaults and round-trips a config update (no token)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const before = await trpcGet<CuratorConfig>(server, "curator.config");
      expect(before.enabled).toBe(false);
      expect(before.defaultAutoApply).toBe("safe_only");
      expect(before.isOperational).toBe(false);

      const after = await trpcPost<CuratorConfig>(server, "curator.setConfig", {
        enabled: true,
        llm: { provider: "openai", endpoint: "https://api.example.com/v1", model: "gpt-x" },
        defaultAutoApply: "high_confidence",
        promptAddendum: "prefer merging",
      });
      expect(after.enabled).toBe(true);
      expect(after.llm.model).toBe("gpt-x");
      expect(after.defaultAutoApply).toBe("high_confidence");
      expect(after.hasToken).toBe(false); // no token set, no secret leak
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("lists runs (empty initially) and run-now no-ops on a disabled config", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const runs = await trpcGet<unknown[]>(server, "curator.runs");
      expect(runs).toEqual([]);

      const result = await trpcPost<{ ran: boolean; reason?: string }>(server, "curator.runNow");
      expect(result).toEqual({ ran: false, reason: "disabled" });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
