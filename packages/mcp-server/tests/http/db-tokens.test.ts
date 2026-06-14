// A4: authenticateMcp accepts dashboard-minted DB tokens (after env tokens), as
// agent-role only. Unit-tests the seam precedence + an end-to-end check that a
// token minted into the data dir authenticates on /mcp, is revocable, and cannot
// reach the admin tRPC surface.

import type { IncomingMessage } from "node:http";
import { createAgentToken, createLibrarianStore, revokeAgentToken } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";
// Import the compiled auth seam: this package's vitest config externalizes
// packages/mcp-server/{src,dist} to Node's own loader (so native deps resolve),
// which can't parse .ts — so tests exercise the built artifact, same as the bin.
import { type AuthConfig, authenticateMcp } from "../../dist/http/auth.js";

function reqWith(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
}

const baseConfig: AuthConfig = {
  adminToken: "admin",
  agentToken: "env-agent",
  agentTokenMap: new Map(),
  allowedOrigins: [],
  host: "127.0.0.1",
  port: 3838,
};

describe("authenticateMcp — verifyDbToken seam", () => {
  it("authenticates a DB token as agent (with its agentId)", () => {
    const config = {
      ...baseConfig,
      verifyDbToken: (t: string) => (t === "db-tok" ? { agentId: "claude" } : null),
    };
    expect(authenticateMcp(reqWith("db-tok"), config)).toEqual({
      role: "agent",
      agentId: "claude",
    });
  });

  it("prefers env tokens over the DB verifier, and never returns admin for a DB token", () => {
    const verifyDbToken = (t: string) =>
      t === "admin" || t === "env-agent" ? { agentId: "evil" } : null;
    const config = { ...baseConfig, verifyDbToken };
    // env admin/agent win (the DB verifier is not consulted for them)
    expect(authenticateMcp(reqWith("admin"), config)).toEqual({ role: "admin" });
    expect(authenticateMcp(reqWith("env-agent"), config)).toEqual({ role: "agent" });
  });

  it("returns null when neither env nor DB matches", () => {
    const config = { ...baseConfig, verifyDbToken: () => null };
    expect(authenticateMcp(reqWith("nope"), config)).toBeNull();
  });
});

describe("DB tokens end-to-end", () => {
  it("authenticate on /mcp, are revocable, and cannot reach admin tRPC", async () => {
    const dataDir = makeTempDir();
    // Mint two tokens into the data dir, then revoke one — all before the server boots.
    const seed = createLibrarianStore({ dataDir });
    const live = createAgentToken(seed, { agentId: "claude" });
    const dead = createAgentToken(seed, { agentId: "claude" });
    revokeAgentToken(seed, dead.id);
    seed.close();

    const server = await startHttpServer({ dataDir });
    const mcp = (token: string) =>
      fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    try {
      expect((await mcp(live.token)).status).toBe(200); // minted token works
      expect((await mcp(server.agentToken)).status).toBe(200); // env token still works
      expect((await mcp(dead.token)).status).toBe(401); // revoked → rejected
      expect((await mcp("lib.bogus.bogus")).status).toBe(401); // unknown → rejected

      // The DB token is agent-role, so the admin tRPC surface rejects it with a
      // precise UNAUTHORIZED (401) — not just any error. The admin tRPC surface
      // now lives on the INTERNAL listener (ADR 0008 P1), so probe it there.
      const adminRes = await fetch(`${server.trpcUrl}/trpc/grooming.config`, {
        headers: { authorization: `Bearer ${live.token}` },
      });
      expect(adminRes.status).toBe(401);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
