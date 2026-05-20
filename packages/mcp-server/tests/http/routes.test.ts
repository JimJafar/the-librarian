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
