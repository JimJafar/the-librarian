// Curator addendum admin tRPC tests (spec 044 D-1, simplified by rethink D4).
//
// Each curator job (intake | grooming) has a git-committed prompt addendum; the
// shared `addendum` router (keyed by `{ job }`) exposes the surviving surface:
//   - get:      a job's committed addendum text + its git version;
//   - set:      commit a new addendum (applies immediately — there is no
//     under-evaluation lifecycle; git history is the version trail);
//   - rollback: restore the file to its prior committed version as a NEW,
//     revertable commit (D4: git is the rollback).
// All are admin-gated (rejected without an admin bearer). Tests pre-seed addendum
// state via a store on the same dataDir before boot and read back the file + git
// log to assert the roll-back recorded a new commit.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { createLibrarianStore, setJobAddendum } from "@librarian/core";
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

async function trpcGet<T>(server: ServerHandle, path: string, input: unknown): Promise<T> {
  const query = `input=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await fetch(`${server.url}/trpc/${path}?${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

interface AddendumState {
  content: string;
  version: string | null;
}
interface RollbackResult extends AddendumState {
  restored: boolean;
  restoredVersion: string | null;
}

const vaultLog = (dataDir: string): string[] =>
  execFileSync("git", ["log", "--format=%s"], {
    cwd: path.join(dataDir, "vault"),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

describe("tRPC addendum admin surface (spec 044 D-1 / rethink D4)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates get + set + rollback (rejected without an admin bearer)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const unauthedGet = await fetch(`${server.url}/trpc/addendum.get?input=`, {
        method: "GET",
      });
      expect(unauthedGet.status).toBeGreaterThanOrEqual(400);

      for (const [proc, body] of [
        ["addendum.set", { job: "grooming", content: "x" }],
        ["addendum.rollback", { job: "grooming" }],
      ] as const) {
        const unauthed = await fetch(`${server.url}/trpc/${proc}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(unauthed.status, proc).toBeGreaterThanOrEqual(400);

        const agent = await fetch(`${server.url}/trpc/${proc}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
          body: JSON.stringify(body),
        });
        expect(agent.status, `${proc} agent`).toBeGreaterThanOrEqual(400);
      }
    } finally {
      await server.stop();
    }
  });

  it("set commits a new addendum that applies immediately; get reads it back", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<AddendumState>(server, "addendum.set", {
        job: "grooming",
        content: "be conservative",
      });
      expect(result.content).toBe("be conservative");
      expect(result.version).toMatch(/^[0-9a-f]{40}$/);

      const read = await trpcGet<AddendumState>(server, "addendum.get", { job: "grooming" });
      expect(read).toEqual(result);
    } finally {
      await server.stop();
    }

    // The change is committed to the vault — the job's next run reads it.
    const after = createLibrarianStore({ dataDir });
    try {
      expect(after.readAddendum("grooming").content).toBe("be conservative");
    } finally {
      after.close();
    }
    expect(vaultLog(dataDir).some((m) => /grooming/.test(m))).toBe(true);
  });

  it("set rejects an addendum over the 2 KB cap (the hard write backstop)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const tooBig = "x".repeat(2049);
      const response = await fetch(`${server.url}/trpc/addendum.set`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ job: "grooming", content: tooBig }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const body = await response.text();
      expect(body).toMatch(/2048|2 KB|bytes/i);
    } finally {
      await server.stop();
    }
  });

  it("get returns the fresh-install default for an unset addendum", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcGet<AddendumState>(server, "addendum.get", { job: "intake" });
      expect(result).toEqual({ content: "", version: null });
    } finally {
      await server.stop();
    }
  });

  it("rollback restores the prior committed addendum and records a new commit", async () => {
    const seed = createLibrarianStore({ dataDir });
    const v1 = setJobAddendum(seed, "grooming", "v1 guidance");
    setJobAddendum(seed, "grooming", "v2 guidance");
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<RollbackResult>(server, "addendum.rollback", {
        job: "grooming",
      });
      expect(result.content).toBe("v1 guidance");
      expect(result.restored).toBe(true);
      expect(result.restoredVersion).toMatch(/^[0-9a-f]{40}$/);
      expect(result.restoredVersion).not.toBe(v1.version); // a NEW commit, not a rewrite
      expect(result.version).toBe(result.restoredVersion);
    } finally {
      await server.stop();
    }

    // The file is restored to v1 content and a new roll-back commit is recorded.
    const after = createLibrarianStore({ dataDir });
    try {
      expect(after.readAddendum("grooming").content).toBe("v1 guidance");
    } finally {
      after.close();
    }
    expect(vaultLog(dataDir).some((m) => /rollback grooming/.test(m))).toBe(true);
  });

  it("rollback is keyed by job — rolls back ONLY the named job", async () => {
    const seed = createLibrarianStore({ dataDir });
    setJobAddendum(seed, "intake", "intake v1");
    setJobAddendum(seed, "intake", "intake v2");
    setJobAddendum(seed, "grooming", "grooming v1");
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost<RollbackResult>(server, "addendum.rollback", { job: "intake" });
    } finally {
      await server.stop();
    }

    const after = createLibrarianStore({ dataDir });
    try {
      expect(after.readAddendum("intake").content).toBe("intake v1"); // rolled back
      // Grooming is untouched.
      expect(after.readAddendum("grooming").content).toBe("grooming v1");
    } finally {
      after.close();
    }
  });

  it("rollback with no committed addendum is a safe no-op", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<RollbackResult>(server, "addendum.rollback", {
        job: "grooming",
      });
      expect(result).toEqual({
        content: "",
        version: null,
        restored: false,
        restoredVersion: null,
      });
    } finally {
      await server.stop();
    }
  });
});
