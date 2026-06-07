// Grooming dry-run admin tRPC tests (spec 044 PR-4 / Task D4).
//
// `grooming.dryRunGrooming` runs a CANDIDATE (uncommitted) grooming addendum over
// the corpus (or one slice) in propose-mode, producing a reviewable batch tagged
// dry-run — WITHOUT committing the candidate live and WITHOUT auto-applying:
//   - slice given → run that ONE slice synchronously and return fast (the latency-
//     sensitive path); the candidate addendum reaches the prompt;
//   - no slice → run the whole corpus as background work, returning a started ack
//     immediately (no progress handle — fire-and-forget, fail-soft).
// Admin-gated (rejected without an admin bearer). INTAKE HAS NO DRY-RUN.
//
// The slice test drives a REAL run against a local OpenAI-compatible stub LLM; the
// seed store + server share a runtime-assembled 64-hex master key so the provider
// token round-trips.

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  addProvider,
  createLibrarianStore,
  readAddendumStatus,
  resolveSecretKey,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// Assemble the 64-hex key + Buffer at runtime — no secret-shaped literal (GitGuardian).
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

interface DryRunSliceResult {
  ran: boolean;
  scope?: string;
}
interface DryRunCorpusAck {
  started: boolean;
}

// A minimal OpenAI-compatible stub that records every prompt it sees and returns one
// fixed grooming `create` op so a slice dry-run files exactly one fresh proposal.
function startStubLlm(): Promise<{
  url: string;
  prompts: string[];
  stop: () => Promise<void>;
}> {
  const prompts: string[] = [];
  const completion = JSON.stringify({
    operations: [
      {
        type: "create",
        memory: {
          title: "Dry-run candidate proposal",
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
        prompts.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: completion } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        prompts,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function seedGrooming(dataDir: string, stubUrl: string) {
  const seed = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
  writeGroomingConfig(seed, { enabled: true, defaultAutoApply: "high_confidence" });
  const provider = addProvider(seed, {
    name: "stub",
    endpoint: stubUrl,
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
  seed.close();
}

describe("tRPC grooming.dryRunGrooming (spec 044 D4)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates dryRunGrooming (rejected without an admin bearer)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const unauthed = await fetch(`${server.url}/trpc/grooming.dryRunGrooming`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateAddendum: "x" }),
      });
      expect(unauthed.status).toBeGreaterThanOrEqual(400);

      const agent = await fetch(`${server.url}/trpc/grooming.dryRunGrooming`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ candidateAddendum: "x" }),
      });
      expect(agent.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
    }
  });

  it("slice dry-run runs synchronously: candidate reaches the prompt, proposal tagged dry-run, live addendum untouched", async () => {
    const stub = await startStubLlm();
    seedGrooming(dataDir, stub.url);

    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      const result = await trpcPost<DryRunSliceResult>(server, "grooming.dryRunGrooming", {
        candidateAddendum: "CANDIDATE steering: prefer concise lessons",
        candidateLabel: "candidate v9",
        slice: { kind: "common_project", projectKey: "proj-x" },
      });
      expect(result).toMatchObject({ ran: true, scope: "slice" });
    } finally {
      await server.stop();
      await stub.stop();
    }

    // The candidate text reached the prompt (redacted-passthrough, no secrets).
    expect(stub.prompts.some((p) => p.includes("CANDIDATE steering: prefer concise lessons"))).toBe(
      true,
    );

    // A fresh dry-run proposal was filed, tagged dry-run (+ candidate label); the
    // live grooming addendum is untouched (never committed) and nothing went active.
    const after = createLibrarianStore({ dataDir });
    try {
      const proposed = after.listAll({ status: "proposed" });
      const fresh = proposed.filter((m) => m.title === "Dry-run candidate proposal");
      expect(fresh).toHaveLength(1);
      const note = fresh[0]?.curator_note as Record<string, unknown> | null | undefined;
      expect(note?.dry_run).toBe(true);
      expect(note?.dry_run_candidate).toBe("candidate v9");
      expect(note?.addendum_version).toBeUndefined();
      // Nothing auto-applied to active.
      expect(
        after.listAll({ status: "active" }).some((m) => m.title === "Dry-run candidate proposal"),
      ).toBe(false);
      // The live addendum file is still absent/empty + accepted (never committed).
      expect(after.readAddendum("grooming").content).toBe("");
      expect(readAddendumStatus(after, "grooming")).toEqual({
        status: "accepted",
        evalVersion: null,
      });
    } finally {
      after.close();
    }
  });

  it("whole-corpus dry-run returns a started ack immediately (background, fail-soft)", async () => {
    const stub = await startStubLlm();
    seedGrooming(dataDir, stub.url);

    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      const result = await trpcPost<DryRunCorpusAck>(server, "grooming.dryRunGrooming", {
        candidateAddendum: "CANDIDATE whole-corpus guidance",
      });
      // Fire-and-forget: the request returns a started ack without awaiting the run.
      expect(result).toEqual({ started: true });
    } finally {
      await server.stop();
      await stub.stop();
    }
  });
});
