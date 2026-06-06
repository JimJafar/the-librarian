// Addendum evaluation lifecycle admin tRPC tests (spec 044 PR-3b / Task D3b).
//
// The two simpler admin lifecycle actions that drive D3a's under-evaluation state
// back to accepted, both keyed by `{ job }` (intake | grooming):
//   - accept: status `under_evaluation` → `accepted`, eval version cleared, so the
//     curator auto-applies again (auto-apply resumes);
//   - rollback: restore the addendum file to its PRIOR committed version + commit
//     the restoration, then status → accepted.
// Both are admin-gated (rejected without an admin bearer). The router is a single
// shared `addendum` router keyed by `{ job }` — the lifecycle is identical per job,
// unlike the per-job `curator`/`intake` routers whose other concerns genuinely
// differ. Tests pre-seed addendum state via a store on the same dataDir before boot
// and read back the file + git log to assert the roll-back recorded a new commit.

import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  createLibrarianStore,
  forceProposeDeps,
  readAddendumStatus,
  setAddendumStatus,
  setJobAddendum,
} from "@librarian/core";
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

interface StatusResult {
  status: string;
  evalVersion: string | null;
}
interface RollbackResult extends StatusResult {
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

describe("tRPC addendum evaluation lifecycle surface (spec 044 D3b)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates accept + rollback (rejected without an admin bearer)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      for (const proc of ["addendum.accept", "addendum.rollback"]) {
        const unauthed = await fetch(`${server.url}/trpc/${proc}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ job: "grooming" }),
        });
        expect(unauthed.status, proc).toBeGreaterThanOrEqual(400);

        const agent = await fetch(`${server.url}/trpc/${proc}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
          body: JSON.stringify({ job: "grooming" }),
        });
        expect(agent.status, `${proc} agent`).toBeGreaterThanOrEqual(400);
      }
    } finally {
      await server.stop();
    }
  });

  it("accept moves under_evaluation → accepted, clears the eval version, resumes auto-apply", async () => {
    // Seed: grooming addendum committed + put under evaluation.
    const seed = createLibrarianStore({ dataDir });
    setJobAddendum(seed, "grooming", "v1 guidance");
    setAddendumStatus(seed, "grooming", "under_evaluation");
    expect(readAddendumStatus(seed, "grooming").status).toBe("under_evaluation");
    // While under evaluation the curator force-proposes (non-empty deps).
    expect(forceProposeDeps(readAddendumStatus(seed, "grooming"))).not.toEqual({});
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<StatusResult>(server, "addendum.accept", { job: "grooming" });
      expect(result).toEqual({ status: "accepted", evalVersion: null });
    } finally {
      await server.stop();
    }

    // Re-open the store and confirm auto-apply resumes: accepted → empty force-
    // propose deps, i.e. the curator no longer force-proposes (byte-identical to
    // the pre-D3a path).
    const after = createLibrarianStore({ dataDir });
    try {
      const status = readAddendumStatus(after, "grooming");
      expect(status).toEqual({ status: "accepted", evalVersion: null });
      expect(forceProposeDeps(status)).toEqual({});
    } finally {
      after.close();
    }
  });

  it("rollback restores the prior committed addendum, records a new commit, and accepts", async () => {
    const seed = createLibrarianStore({ dataDir });
    const v1 = setJobAddendum(seed, "grooming", "v1 guidance");
    setJobAddendum(seed, "grooming", "v2 guidance (under evaluation)");
    setAddendumStatus(seed, "grooming", "under_evaluation");
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<RollbackResult>(server, "addendum.rollback", {
        job: "grooming",
      });
      expect(result.status).toBe("accepted");
      expect(result.evalVersion).toBeNull();
      expect(result.restored).toBe(true);
      expect(result.restoredVersion).toMatch(/^[0-9a-f]{40}$/);
      expect(result.restoredVersion).not.toBe(v1.version);
    } finally {
      await server.stop();
    }

    // The file is restored to v1 content, a new roll-back commit is recorded, and
    // status is accepted (auto-apply resumes).
    const after = createLibrarianStore({ dataDir });
    try {
      expect(after.readAddendum("grooming").content).toBe("v1 guidance");
      expect(readAddendumStatus(after, "grooming")).toEqual({
        status: "accepted",
        evalVersion: null,
      });
    } finally {
      after.close();
    }
    expect(vaultLog(dataDir).some((m) => /rollback grooming/.test(m))).toBe(true);
  });

  it("rollback is keyed by job — accepts/rolls back ONLY the named job", async () => {
    const seed = createLibrarianStore({ dataDir });
    setJobAddendum(seed, "intake", "intake v1");
    setJobAddendum(seed, "intake", "intake v2");
    setAddendumStatus(seed, "intake", "under_evaluation");
    setJobAddendum(seed, "grooming", "grooming v1");
    setAddendumStatus(seed, "grooming", "under_evaluation");
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
      expect(readAddendumStatus(after, "intake").status).toBe("accepted");
      // Grooming is untouched: still under evaluation, content unchanged.
      expect(after.readAddendum("grooming").content).toBe("grooming v1");
      expect(readAddendumStatus(after, "grooming").status).toBe("under_evaluation");
    } finally {
      after.close();
    }
  });
});
