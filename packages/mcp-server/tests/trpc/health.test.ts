// tRPC mount integration tests.
//
// Spawns `dist/bin/http.js` and verifies the tRPC adapter is wired at
// /trpc/*. health.ping is public; the admin-token gate on the context
// is exercised indirectly here (no token still resolves the public
// procedure) — proper admin-gated procedures land in T4.4/T4.5.

import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOkResponse {
  result: { data: { ok: true } };
}

describe("tRPC /trpc surface", () => {
  it("health.ping returns { ok: true } without auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/health.ping`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as TrpcOkResponse;
      expect(body.result.data.ok).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("health.ping accepts an admin bearer token", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/health.ping`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as TrpcOkResponse;
      expect(body.result.data.ok).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns a tRPC error for an unknown procedure", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/health.unknown`);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/No.+procedure/i);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
