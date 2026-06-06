// Awareness-primer admin tRPC tests (spec 041 PR-1 / Task A1).
//
// The admin surface for the server-sourced awareness primer (spec 041 1B):
//   - awareness.primer (query) → the current primer with the shipped default
//     applied when unset; an explicitly-cleared primer reads back as "";
//   - awareness.setPrimer (mutation) → sets the text ("" DISABLES it; any other
//     string is the operator's custom primer) and returns the fresh value.
// Both admin-gated (rejected without an admin bearer).

import { DEFAULT_AWARENESS_PRIMER, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

async function trpcGet<T>(server: ServerHandle, path: string): Promise<T> {
  const response = await fetch(`${server.url}/trpc/${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

interface PrimerResult {
  primer: string;
}

describe("tRPC awareness primer surface (spec 041 A1)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates primer read + write (rejected without an admin bearer)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const readUnauthed = await fetch(`${server.url}/trpc/awareness.primer`, { method: "GET" });
      expect(readUnauthed.status).toBeGreaterThanOrEqual(400);

      const writeUnauthed = await fetch(`${server.url}/trpc/awareness.setPrimer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primer: "x" }),
      });
      expect(writeUnauthed.status).toBeGreaterThanOrEqual(400);

      const writeAgent = await fetch(`${server.url}/trpc/awareness.setPrimer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ primer: "x" }),
      });
      expect(writeAgent.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
    }
  });

  it("reads the shipped default when the primer was never set", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(result.primer).toBe(DEFAULT_AWARENESS_PRIMER);
    } finally {
      await server.stop();
    }
  });

  it("round-trips a custom primer through write → read", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const custom = "You have memory. Recall before asking.";
      const wrote = await trpcPost<PrimerResult>(server, "awareness.setPrimer", { primer: custom });
      expect(wrote.primer).toBe(custom);

      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.primer).toBe(custom);
    } finally {
      await server.stop();
    }
  });

  it("an explicit empty string disables the primer (reads back '')", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const wrote = await trpcPost<PrimerResult>(server, "awareness.setPrimer", { primer: "" });
      expect(wrote.primer).toBe("");

      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.primer).toBe("");
    } finally {
      await server.stop();
    }
  });

  it("persists the custom primer across a server restart (settings store)", async () => {
    const custom = "Persisted primer.";
    // Seed via a store on the same dataDir, then boot a fresh server and read back.
    const seed = createLibrarianStore({ dataDir });
    seed.setSetting("awareness.primer", custom);
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.primer).toBe(custom);
    } finally {
      await server.stop();
    }
  });
});
