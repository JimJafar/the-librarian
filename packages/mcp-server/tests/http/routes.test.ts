// Minimal HTTP routes coverage post-T7.1.
//
// The legacy /api/* REST surface and dashboard file serves have been
// retired (see http.test.ts / sessions.http.test.ts removed in T7.1).
// What remains is intentionally small: /healthz, /mcp + auth, and the
// tRPC mount. tRPC-specific behaviour is covered in tests/trpc/*. This
// suite just confirms the trimmed router still:
//   - exposes /healthz unauthenticated
//   - 404s on unknown paths (no public dashboard files)
//   - protects /mcp with the admin/agent token
//   - 401s when no token is supplied on /mcp
//   - rejects browser origins not on the allow-list

import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  makeTempDir,
  postJson,
  startHttpServer,
} from "../../../../test/helpers.js";

describe("HTTP routes (post-T7.1)", () => {
  it("exposes /healthz without auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      const res = await fetch(`${server.url}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.mcp_auth).toBe("enabled");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns 404 for legacy dashboard paths", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      for (const pathname of ["/", "/styles.css", "/app.js", "/api/state", "/api/memories"]) {
        const res = await fetch(`${server.url}${pathname}`);
        expect(res.status, `${pathname} should 404`).toBe(404);
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("requires a bearer token on /mcp and accepts admin", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      const unauth = await postJson(`${server.url}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(unauth.response.status).toBe(401);

      const ok = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { authorization: "Bearer http-token" },
      );
      expect(ok.response.status).toBe(200);
      expect(ok.json).toMatchObject({ jsonrpc: "2.0", id: 1 });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("flags a memory over /mcp end-to-end and no longer exposes verify_memory", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    const auth = { authorization: "Bearer http-token" };
    const callTool = (name: string, args: Record<string, unknown>) =>
      postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        auth,
      );
    try {
      // flag_memory is advertised; verify_memory is gone.
      const list = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        auth,
      );
      const names = (list.json as { result: { tools: { name: string }[] } }).result.tools.map(
        (t) => t.name,
      );
      expect(names).toContain("flag_memory");
      expect(names).not.toContain("verify_memory");

      // Seed a memory, then flag it end-to-end.
      await callTool("remember", {
        agent_id: "codex",
        title: "Old endpoint",
        body: "POST to /legacy for the API.",
      });
      const recall = await callTool("recall", {
        agent_id: "codex",
        query: "endpoint",
        include_ids: true,
      });
      const recallText = (recall.json as { result: { content: { text: string }[] } }).result
        .content[0]!.text;
      const memoryId = /\[(mem_[a-f0-9-]+)\]/.exec(recallText)?.[1];
      expect(memoryId).toBeTruthy();

      const flag = await callTool("flag_memory", {
        agent_id: "codex",
        memory_id: memoryId,
        reason: "the API moved to /v2",
      });
      expect(flag.response.status).toBe(200);
      const flagText = (flag.json as { result: { content: { text: string }[] } }).result.content[0]!
        .text;
      expect(flagText).toMatch(/flag/i);

      // verify_memory is method-not-found (the tool was retired).
      const verify = await callTool("verify_memory", { memory_id: memoryId, result: "useful" });
      expect((verify.json as { error: { message: string } }).error.message).toMatch(
        /Unknown tool: verify_memory/,
      );
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects browser origins not on the allow-list", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      // /healthz is intentionally open; the origin gate runs after it,
      // so /mcp is the right probe.
      const res = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { origin: "https://evil.example", authorization: "Bearer http-token" },
      );
      expect(res.response.status).toBe(403);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
