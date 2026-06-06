// Addendum evaluation lifecycle admin tRPC tests (spec 044 PR-3b/3c / Tasks D3b+D3c).
//
// The admin lifecycle actions that drive D3a's under-evaluation state, keyed by
// `{ job }` (intake | grooming):
//   - accept: status `under_evaluation` → `accepted`, eval version cleared, so the
//     curator auto-applies again (auto-apply resumes);
//   - rollback: restore the addendum file to its PRIOR committed version + commit
//     the restoration, then status → accepted.
//   - reEvaluate (D3c, GROOMING ONLY): discard the proposals tagged with the current
//     eval version and re-run grooming over their slices under the current addendum,
//     producing a fresh batch. Intake returns `intake_not_replayable` (the inbox is
//     consumed on apply — there is no original submission to re-judge).
// All are admin-gated (rejected without an admin bearer). The router is a single
// shared `addendum` router keyed by `{ job }` — the lifecycle is identical per job,
// unlike the per-job `curator`/`intake` routers whose other concerns genuinely
// differ. Tests pre-seed addendum state via a store on the same dataDir before boot
// and read back the file + git log to assert the roll-back recorded a new commit;
// the grooming re-evaluate test drives a REAL run against a local stub LLM.

import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  addProvider,
  createLibrarianStore,
  forceProposeDeps,
  readAddendumStatus,
  resolveSecretKey,
  setAddendumStatus,
  setJobAddendum,
  writeConsumerConfig,
  writeCuratorConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// The grooming re-evaluate test encrypts a provider token, so the seed store and
// the server must share a master key. Assemble the 64-hex key + Buffer at runtime —
// no secret-shaped literal in source (GitGuardian).
const SECRET_KEY_HEX = "0123456789abcdef".repeat(4);
const SECRET_KEY = resolveSecretKey(SECRET_KEY_HEX);

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

interface StatusResult {
  status: string;
  evalVersion: string | null;
}
interface RollbackResult extends StatusResult {
  restored: boolean;
  restoredVersion: string | null;
}
type ReEvaluateSummary =
  | { reEvaluated: true; count: number }
  | { reEvaluated: false; reason: string };

const vaultLog = (dataDir: string): string[] =>
  execFileSync("git", ["log", "--format=%s"], {
    cwd: path.join(dataDir, "vault"),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

// A minimal OpenAI-compatible chat-completions stub the curator LLM client can talk
// to. Returns one fixed grooming `create` op so a re-evaluate run files exactly one
// fresh proposal (forced to `proposed` under evaluation).
function startStubLlm(): Promise<{ url: string; stop: () => Promise<void> }> {
  const completion = JSON.stringify({
    operations: [
      {
        type: "create",
        memory: {
          title: "Fresh reeval proposal",
          body: "a durable lesson",
          category: "lessons",
          visibility: "common",
          scope: "project",
          project_key: "proj-x",
        },
        rationale: "novel durable lesson",
        confidence: 0.99,
      },
    ],
  });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: completion } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("tRPC addendum evaluation lifecycle surface (spec 044 D3b+D3c)", () => {
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
      for (const proc of ["addendum.accept", "addendum.rollback", "addendum.reEvaluate"]) {
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

  it("reEvaluate is unsupported for intake (not replayable — the inbox is consumed)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<ReEvaluateSummary>(server, "addendum.reEvaluate", {
        job: "intake",
      });
      expect(result).toEqual({ reEvaluated: false, reason: "intake_not_replayable" });
    } finally {
      await server.stop();
    }
  });

  it("reEvaluate (grooming) discards the tagged batch and re-runs grooming for a fresh one", async () => {
    const stub = await startStubLlm();
    // Seed: grooming enabled + pointed at the stub, an active memory, a tagged stale
    // proposal, and grooming under evaluation against a committed addendum. The seed
    // store shares the server's master key so the provider token round-trips.
    const seed = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
    writeCuratorConfig(seed, { enabled: true, defaultAutoApply: "high_confidence" });
    const provider = addProvider(seed, {
      name: "stub",
      endpoint: stub.url,
      token: "dummy-stub-token",
    });
    writeConsumerConfig(seed, "grooming", { providerId: provider.id, model: "gpt-x" });
    seed.createMemory({
      agent_id: "agent-a",
      title: "Active anchor",
      body: "b",
      category: "lessons",
      visibility: "common",
      scope: "project",
      project_key: "proj-x",
      priority: "normal",
      confidence: "working",
    });
    setJobAddendum(seed, "grooming", "v1 guidance under evaluation");
    setAddendumStatus(seed, "grooming", "under_evaluation");
    const version = seed.readAddendum("grooming").version;
    seed.createMemory(
      {
        agent_id: "agent-a",
        title: "Stale curator proposal",
        body: "stale",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
      },
      { requires_approval: true, curator_note: { addendum_version: version } },
    );
    seed.close();

    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      const result = await trpcPost<ReEvaluateSummary>(server, "addendum.reEvaluate", {
        job: "grooming",
      });
      expect(result).toEqual({ reEvaluated: true, count: 1 });
    } finally {
      await server.stop();
      await stub.stop();
    }

    // The stale proposal is discarded; a fresh one (from the stub) replaces it,
    // re-tagged with the current eval version; nothing was auto-applied to active.
    const after = createLibrarianStore({ dataDir });
    try {
      const proposed = after.listAll({ status: "proposed" });
      expect(proposed.some((m) => m.title === "Stale curator proposal")).toBe(false);
      const fresh = proposed.filter((m) => m.title === "Fresh reeval proposal");
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.curator_note?.addendum_version).toBe(version);
      expect(
        after.listAll({ status: "active" }).some((m) => m.title === "Fresh reeval proposal"),
      ).toBe(false);
    } finally {
      after.close();
    }
  });

  it("admin-gates get + set (rejected without an admin bearer)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const unauthedGet = await fetch(`${server.url}/trpc/addendum.get?input=`, {
        method: "GET",
      });
      expect(unauthedGet.status).toBeGreaterThanOrEqual(400);

      const unauthedSet = await fetch(`${server.url}/trpc/addendum.set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job: "grooming", content: "x" }),
      });
      expect(unauthedSet.status).toBeGreaterThanOrEqual(400);

      const agentSet = await fetch(`${server.url}/trpc/addendum.set`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ job: "grooming", content: "x" }),
      });
      expect(agentSet.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
    }
  });

  it("set commits a new addendum and puts the job UNDER EVALUATION; get reads it back", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{
        content: string;
        version: string | null;
        status: string;
        evalVersion: string | null;
      }>(server, "addendum.set", { job: "grooming", content: "be conservative" });
      expect(result.content).toBe("be conservative");
      expect(result.version).toMatch(/^[0-9a-f]{40}$/);
      // A freshly-changed addendum goes under evaluation (the curator force-proposes).
      expect(result.status).toBe("under_evaluation");
      expect(result.evalVersion).toBe(result.version);
    } finally {
      await server.stop();
    }

    // The change is committed to the vault and the status persists.
    const after = createLibrarianStore({ dataDir });
    try {
      expect(after.readAddendum("grooming").content).toBe("be conservative");
      expect(readAddendumStatus(after, "grooming").status).toBe("under_evaluation");
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
      const result = await trpcGet<{
        content: string;
        version: string | null;
        status: string;
        evalVersion: string | null;
      }>(server, "addendum.get", { job: "intake" });
      expect(result).toEqual({
        content: "",
        version: null,
        status: "accepted",
        evalVersion: null,
      });
    } finally {
      await server.stop();
    }
  });
});
