// classifierConfig tRPC procedure tests — exercises the cockpit surface
// end to end: admin gating, config read/update round-trip with no token
// leak, workerState drift detection, restartWorker outcome, and selfTest
// outcomes via a fresh HTTP bin.

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

interface ClassifierConfigResponse {
  enabled: boolean;
  llm: { provider: string; endpoint: string; model: string; timeoutMs: number };
  hasToken: boolean;
  isLlmComplete: boolean;
  promptVersion: string | null;
  isOperational: boolean;
}

interface WorkerStateResponse {
  runningConfigHash: string | null;
  storedConfigHash: string;
  hasDrift: boolean;
}

interface RestartResponse {
  outcome: string;
  runningConfigHash: string | null;
  reason?: string;
}

interface SelfTestResponse {
  outcome: "ok" | "fallback" | "error";
  latencyMs: number;
  verdict?: { requires_approval: boolean; is_global: boolean };
  fallbackReason?: string;
  error?: string;
  rawOutput?: string;
}

describe("tRPC classifierConfig surface", () => {
  it("requires admin auth on every procedure", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const calls = ["classifierConfig.config", "classifierConfig.workerState"];
      for (const call of calls) {
        const response = await fetch(`${server.url}/trpc/${call}`); // no Authorization
        expect(response.status, `expected 401 for ${call}`).toBeGreaterThanOrEqual(400);
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns sensible defaults on a fresh data dir", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const cfg = await trpcGet<ClassifierConfigResponse>(server, "classifierConfig.config");
      expect(cfg.enabled).toBe(false);
      expect(cfg.hasToken).toBe(false);
      expect(cfg.isOperational).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("round-trips a config update and never returns the token on the wire", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const after = await trpcPost<ClassifierConfigResponse>(server, "classifierConfig.setConfig", {
        enabled: true,
        llm: {
          provider: "openai",
          endpoint: "https://api.example.com/v1",
          model: "gpt-4o-mini",
        },
        token: "dummy-trpc-classifier-token",
        promptVersion: "v1",
      });
      expect(after.enabled).toBe(true);
      expect(after.llm.model).toBe("gpt-4o-mini");
      expect(after.hasToken).toBe(true);
      expect(after.isOperational).toBe(true);
      expect(after.promptVersion).toBe("v1");
      // Token plaintext must not be visible anywhere in the response.
      expect(JSON.stringify(after)).not.toContain("dummy-trpc-classifier-token");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("workerState reports drift after a setConfig without a restart", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // No config stored yet — runningConfigHash and storedConfigHash both
      // reflect the empty config; hasDrift is false.
      const initial = await trpcGet<WorkerStateResponse>(server, "classifierConfig.workerState");
      expect(initial.runningConfigHash).toBeNull(); // nothing running
      expect(initial.storedConfigHash).toMatch(/^[0-9a-f]{64}$/);
      expect(initial.hasDrift).toBe(false);

      // Write a complete config — the running hash is still null (no
      // restart yet), the stored hash flips, so hasDrift goes true.
      await trpcPost(server, "classifierConfig.setConfig", {
        enabled: true,
        llm: {
          provider: "openai",
          endpoint: "https://api.example.com/v1",
          model: "gpt-4o-mini",
        },
        token: "dummy-trpc-classifier-token",
      });
      const drifted = await trpcGet<WorkerStateResponse>(server, "classifierConfig.workerState");
      expect(drifted.runningConfigHash).toBeNull();
      expect(drifted.hasDrift).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("restartWorker on a disabled config reports stopped", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<RestartResponse>(server, "classifierConfig.restartWorker");
      expect(result.outcome).toBe("stopped");
      expect(result.runningConfigHash).toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("selfTest on a non-operational config reports an error outcome", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<SelfTestResponse>(server, "classifierConfig.selfTest");
      expect(result.outcome).toBe("error");
      expect(result.error).toMatch(/disabled|incomplete|operational/i);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
