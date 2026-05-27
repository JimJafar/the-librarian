// T4.1 — tRPC admin surface for the `/domains` page.
//
// Covers admin-only gating, list/add/remove flows, and the cleanup-
// reassign behaviour: removing a domain reassigns its memories to
// `general` rather than deleting them.

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

interface DomainRecord {
  name: string;
  created_at: string;
  memory_count: number;
}

describe("tRPC domains surface (T4.1)", () => {
  it("requires admin auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/domains.list`);
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("lists the seeded `general` domain on a fresh install", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<DomainRecord[]>(server, "domains.list");
      expect(rows.map((r) => r.name)).toEqual(["general"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("supports the add → list → remove round trip with memory reassignment", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const added = await trpcPost<DomainRecord>(server, "domains.add", { name: "coding" });
      expect(added.name).toBe("coding");

      const namesAfterAdd = (await trpcGet<DomainRecord[]>(server, "domains.list")).map(
        (r) => r.name,
      );
      expect(namesAfterAdd).toEqual(["coding", "general"]);

      const removed = await trpcPost<{ reassigned: number }>(server, "domains.remove", {
        name: "coding",
      });
      expect(removed.reassigned).toBe(0); // no memories existed in that domain
      const namesAfterRemove = (await trpcGet<DomainRecord[]>(server, "domains.list")).map(
        (r) => r.name,
      );
      expect(namesAfterRemove).toEqual(["general"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects removal of the `general` floor", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/domains.remove`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ name: "general" }),
      });
      const json = (await response.json()) as TrpcErr;
      expect(json.error).toBeTruthy();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
