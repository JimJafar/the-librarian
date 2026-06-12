// Primer admin tRPC tests (spec 041 A1, repointed by rethink T11).
//
// The dashboard's read/write surface over `vault/primer.md`:
//   - awareness.primer (query) → the file's content (the shipped default right
//     after first boot; "" when the operator disabled it);
//   - awareness.setPrimer (mutation) → commits the new text to the vault file;
//     refuses >2KB with a teaching BAD_REQUEST (never a 500).
// Both admin-gated (rejected without an admin bearer). The legacy settings-key
// primer (`awareness.primer`) is migrated into the file once at boot.

import { DEFAULT_PRIMER, createLibrarianStore } from "@librarian/core";
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

describe("tRPC primer surface (vault/primer.md, rethink T11)", () => {
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

  it("reads the boot-seeded default primer on a fresh install", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(result.primer).toBe(DEFAULT_PRIMER);
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

  it("refuses an over-2KB primer with a teaching BAD_REQUEST, leaving the file untouched", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/awareness.setPrimer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ primer: "x".repeat(2049) }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("2048 bytes");
      expect(body.error.message).toContain("2049 bytes");

      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.primer).toBe(DEFAULT_PRIMER);
    } finally {
      await server.stop();
    }
  });

  it("migrates the legacy settings-key primer into vault/primer.md at boot (one-time)", async () => {
    const custom = "Legacy settings-key primer.";
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

  it("persists an edited primer across a server restart (it is a committed vault file)", async () => {
    const custom = "Persisted primer.";
    const first = await startHttpServer({ dataDir });
    try {
      await trpcPost<PrimerResult>(first, "awareness.setPrimer", { primer: custom });
    } finally {
      await first.stop();
    }

    const second = await startHttpServer({ dataDir });
    try {
      const read = await trpcGet<PrimerResult>(second, "awareness.primer");
      expect(read.primer).toBe(custom);
    } finally {
      await second.stop();
    }
  });
});
