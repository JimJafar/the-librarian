// Classifier-evaluation tRPC surface — admin gating + soft-alert
// computation against synthesized memory.classified events. The
// runEval-mutation happy path needs a live LLM mock and is covered
// at the @librarian/classifier-eval package level; here we focus on
// the wiring guarantees the router owns.

import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface ServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.url}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as { result?: { data: T }; error?: unknown };
  if (response.status >= 400 || json.error !== undefined) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return json.result!.data;
}

interface SoftAlert {
  maxRetriesCount: number;
  windowSize: number;
  rate: number;
  exceedsThreshold: boolean;
}

describe("tRPC classifierEval surface", () => {
  it("requires admin auth on runEval", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/classifierEval.runEval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("requires admin auth on softAlert", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/classifierEval.softAlert`);
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("softAlert returns zero rate when no classifications have been recorded", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcGet<SoftAlert>(server, "classifierEval.softAlert");
      expect(result.maxRetriesCount).toBe(0);
      expect(result.windowSize).toBe(0);
      expect(result.exceedsThreshold).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
