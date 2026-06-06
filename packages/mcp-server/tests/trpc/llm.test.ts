// LLM provider + per-consumer config admin tRPC tests (spec 042 §4). Spawns the
// real HTTP bin and exercises the surface end to end: admin gating, provider CRUD
// (token write-only — never returned), and per-consumer (intake/grooming) config
// round-trip + independence.

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

interface Provider {
  id: string;
  name: string;
  endpoint: string;
  hasToken: boolean;
}

interface ConsumerConfig {
  consumer: string;
  providerId: string;
  providerExists: boolean;
  endpoint: string;
  model: string;
  timeoutMs: number;
  hasToken: boolean;
  isOperational: boolean;
}

describe("tRPC llm provider surface", () => {
  it("requires admin auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/llm.listProviders`);
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("round-trips provider CRUD without ever returning the token", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      expect(await trpcGet<Provider[]>(server, "llm.listProviders")).toEqual([]);

      const created = await trpcPost<Provider>(server, "llm.addProvider", {
        name: "OpenAI",
        endpoint: "https://api.openai.com/v1",
        token: "dummy-openai-token",
      });
      expect(created.name).toBe("OpenAI");
      expect(created.hasToken).toBe(true);
      // Lock the contract by shape, not just a fixture substring: no token field.
      expect(created).not.toHaveProperty("token");
      expect(Object.keys(created).sort()).toEqual(["endpoint", "hasToken", "id", "name"]);
      expect(JSON.stringify(created)).not.toContain("dummy-openai-token");

      const list = await trpcGet<Provider[]>(server, "llm.listProviders");
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain("dummy-openai-token");

      const updated = await trpcPost<Provider>(server, "llm.updateProvider", {
        id: created.id,
        name: "OpenAI (prod)",
      });
      expect(updated.name).toBe("OpenAI (prod)");
      expect(updated.id).toBe(created.id);

      const afterDelete = await trpcPost<Provider[]>(server, "llm.deleteProvider", {
        id: created.id,
      });
      expect(afterDelete).toEqual([]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("round-trips per-consumer config and keeps intake + grooming independent", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const cheap = await trpcPost<Provider>(server, "llm.addProvider", {
        name: "Cheap",
        endpoint: "https://cheap.example/v1",
        token: "dummy-cheap",
      });
      const strong = await trpcPost<Provider>(server, "llm.addProvider", {
        name: "Strong",
        endpoint: "https://strong.example/v1",
        token: "dummy-strong",
      });

      await trpcPost<ConsumerConfig>(server, "llm.setConsumerConfig", {
        consumer: "intake",
        providerId: cheap.id,
        model: "mini",
      });
      await trpcPost<ConsumerConfig>(server, "llm.setConsumerConfig", {
        consumer: "grooming",
        providerId: strong.id,
        model: "max",
      });

      const intake = await trpcGet<ConsumerConfig>(server, "llm.consumerConfig", {
        consumer: "intake",
      });
      const grooming = await trpcGet<ConsumerConfig>(server, "llm.consumerConfig", {
        consumer: "grooming",
      });
      expect(intake.endpoint).toBe("https://cheap.example/v1");
      expect(intake.model).toBe("mini");
      expect(intake.isOperational).toBe(true);
      expect(grooming.endpoint).toBe("https://strong.example/v1");
      expect(grooming.model).toBe("max");
      expect(grooming.isOperational).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
