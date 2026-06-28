// A5: token-management admin tRPC surface. Spawns the real HTTP bin and
// exercises create → list → revoke end to end, plus admin gating (the agent
// role must not reach it) and the never-leak-the-secret contract.

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

interface TokenMeta {
  id: string;
  agentId: string;
  label: string;
  scope: "agent" | "capture";
  created_at: string;
}

describe("tRPC tokens surface", () => {
  it("is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // Token management is admin-only; post-P3 that is enforced by the network
      // boundary — the admin tRPC surface 404s on the public port a network
      // agent can reach, even with an agent bearer.
      const res = await fetch(`${server.url}/trpc/tokens.list`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("token creation is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir }); // agentToken defaults to "agent-token"
    try {
      const res = await fetch(`${server.url}/trpc/tokens.create`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ agentId: "claude" }),
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("creates a token (plaintext once), lists metadata only, and revokes", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const created = await trpcPost<{ id: string; token: string }>(server, "tokens.create", {
        agentId: "claude",
        label: "laptop",
      });
      expect(created.token.startsWith("lib.")).toBe(true);
      expect(created.id.length).toBeGreaterThan(0);

      const list = await trpcGet<TokenMeta[]>(server, "tokens.list");
      const mine = list.find((t) => t.id === created.id);
      expect(mine).toMatchObject({ agentId: "claude", label: "laptop" });
      // Never leak the secret material.
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain(created.token);
      expect(serialized).not.toContain("hash");
      expect(serialized).not.toContain("salt");

      const revoked = await trpcPost<{ revoked: boolean }>(server, "tokens.revoke", {
        id: created.id,
      });
      expect(revoked.revoked).toBe(true);

      const after = await trpcGet<TokenMeta[]>(server, "tokens.list");
      expect(after.some((t) => t.id === created.id)).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("mints a capture-scoped token; an unspecified scope defaults to agent (D2/D21)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const cap = await trpcPost<{ id: string; token: string }>(server, "tokens.create", {
        agentId: "clipper",
        scope: "capture",
      });
      const plain = await trpcPost<{ id: string; token: string }>(server, "tokens.create", {
        agentId: "claude",
      });
      const list = await trpcGet<TokenMeta[]>(server, "tokens.list");
      expect(list.find((t) => t.id === cap.id)?.scope).toBe("capture");
      expect(list.find((t) => t.id === plain.id)?.scope).toBe("agent");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
