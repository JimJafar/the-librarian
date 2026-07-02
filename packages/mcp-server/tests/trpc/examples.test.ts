// Intake examples-document admin tRPC tests (proposal-review rework 2026-07-01,
// F4 / D3). ONE curator-distilled document (`.curator/intake-examples.md`)
// teaching the intake judge what NOT to extract — a sibling of the addendum
// with the same committed-vault-file mechanics:
//   - get:      the committed examples text + its git version;
//   - set:      commit a new document (byte-capped by the
//     curator.intake.examples_max_bytes knob, default 4096 — over-cap REFUSED
//     with a teaching error);
//   - rollback: restore the prior committed version as a NEW revertable commit.
// All admin-gated; unreachable from the public listener (ADR 0008 P3). The
// distill mutation is its own slice (task 7) and is not covered here.

import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  setIntakeExamples,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// Assemble the 64-hex key at runtime — no secret-shaped literal (GitGuardian).
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
  trpcUrl: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
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
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

interface ExamplesState {
  content: string;
  version: string | null;
}
interface RollbackResult extends ExamplesState {
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

describe("tRPC examples admin surface (F4 / D3)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("get + set + rollback are unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const agentGet = await fetch(`${server.url}/trpc/examples.get`, {
        method: "GET",
        headers: { authorization: "Bearer agent-token" },
      });
      expect(agentGet.status).toBe(404);

      for (const [proc, body] of [
        ["examples.set", { content: "x" }],
        ["examples.rollback", {}],
      ] as const) {
        const agent = await fetch(`${server.url}/trpc/${proc}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
          body: JSON.stringify(body),
        });
        expect(agent.status).toBe(404);
      }
    } finally {
      await server.stop();
    }
  });

  it("get returns empty content + null version on a fresh install", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const state = await trpcGet<ExamplesState>(server, "examples.get");
      expect(state).toEqual({ content: "", version: null });
    } finally {
      await server.stop();
    }
  });

  it("set commits the document and get round-trips it with a version hash", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const state = await trpcPost<ExamplesState>(server, "examples.set", {
        content: "- One-off TODOs: noop.",
      });
      expect(state.content).toBe("- One-off TODOs: noop.");
      expect(state.version).toMatch(/^[0-9a-f]{40}$/);

      const readBack = await trpcGet<ExamplesState>(server, "examples.get");
      expect(readBack).toEqual(state);
      expect(vaultLog(dataDir).some((m) => /intake-examples/.test(m))).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("set refuses an over-cap document with a teaching error naming the cap", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      await expect(trpcPost(server, "examples.set", { content: "x".repeat(4097) })).rejects.toThrow(
        /4096/,
      );
      const state = await trpcGet<ExamplesState>(server, "examples.get");
      expect(state.content).toBe(""); // nothing was committed
    } finally {
      await server.stop();
    }
  });

  it("rollback restores the prior committed version as a new commit", async () => {
    // Pre-seed two versions via a store on the same dataDir before boot.
    {
      const store = createLibrarianStore({ dataDir });
      try {
        setIntakeExamples(store, "version one");
        setIntakeExamples(store, "version two");
      } finally {
        store.close();
      }
    }
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<RollbackResult>(server, "examples.rollback");
      expect(result.restored).toBe(true);
      expect(result.content).toBe("version one");
      // The roll-back is itself a new commit, not history rewrite.
      expect(vaultLog(dataDir)[0]).toMatch(/rollback/);
    } finally {
      await server.stop();
    }
  });

  it("rollback with no committed document is a safe no-op", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<RollbackResult>(server, "examples.rollback");
      expect(result.restored).toBe(false);
      expect(result.content).toBe("");
    } finally {
      await server.stop();
    }
  });
});

// A minimal OpenAI-compatible stub recording every prompt body and returning
// queued completions in order (the grooming-chat test's pattern).
function startStubLlm(completions: string[]): Promise<{
  url: string;
  prompts: string[];
  stop: () => Promise<void>;
}> {
  const prompts: string[] = [];
  let i = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        prompts.push(body);
        const content = completions[Math.min(i++, completions.length - 1)] ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
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

// Seed a store whose `chat` consumer resolves (via the grooming fallback), an
// existing examples doc, and one proposed intake submission to make an example of.
function seedDistill(
  dataDir: string,
  stubUrl: string,
  opts: { currentDoc?: string } = {},
): { proposalId: string } {
  const store = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
  try {
    const provider = addProvider(store, {
      name: "stub",
      endpoint: stubUrl,
      token: "dummy-stub-token",
    });
    writeConsumerConfig(store, "grooming", { providerId: provider.id, model: "gpt-x" });
    if (opts.currentDoc) setIntakeExamples(store, opts.currentDoc);
    const created = store.createMemory(
      {
        agent_id: "scribe",
        title: "TODO fix flaky test",
        body: "TODO: fix the flaky auth test tomorrow.",
      },
      {
        requires_approval: true,
        curator_note: { source: "intake", proposed_action: "create", rationale: "low value" },
      },
    );
    return { proposalId: created.memory.id };
  } finally {
    store.close();
  }
}

describe("tRPC examples.distill (F4, teach flow)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("returns current + candidate + diff, prompting with the doc, submission, and note — writing NOTHING", async () => {
    const stub = await startStubLlm(["- One-off task reminders: not memory-worthy."]);
    const { proposalId } = seedDistill(dataDir, stub.url, {
      currentDoc: "- Existing example.",
    });
    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      const result = await trpcPost<{ current: string; candidate: string; diff: string }>(
        server,
        "examples.distill",
        { proposalId, note: "one-off task noise" },
      );
      expect(result.current).toBe("- Existing example.");
      expect(result.candidate).toBe("- One-off task reminders: not memory-worthy.");
      expect(result.diff).toContain("+- One-off task reminders: not memory-worthy.");

      // The prompt carried the current doc, the submission, and the note.
      const prompt = stub.prompts[0]!;
      expect(prompt).toContain("Existing example");
      expect(prompt).toContain("flaky auth test");
      expect(prompt).toContain("one-off task noise");

      // PURE: the committed doc is unchanged and the proposal still proposed.
      const state = await trpcGet<ExamplesState>(server, "examples.get");
      expect(state.content).toBe("- Existing example.");
      {
        const store = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
        try {
          expect(store.getMemory(proposalId)?.status).toBe("proposed");
        } finally {
          store.close();
        }
      }
    } finally {
      await server.stop();
      await stub.stop();
    }
  });

  it("errors NOT_FOUND for an unknown proposal id", async () => {
    const stub = await startStubLlm(["- x"]);
    seedDistill(dataDir, stub.url);
    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      await expect(
        trpcPost(server, "examples.distill", { proposalId: "mem_ghost" }),
      ).rejects.toThrow(/failed/);
    } finally {
      await server.stop();
      await stub.stop();
    }
  });

  it("errors with a teaching message when no chat LLM is configured", async () => {
    // Seed WITHOUT a provider: create the proposal only.
    {
      const store = createLibrarianStore({ dataDir });
      try {
        store.createMemory(
          { agent_id: "scribe", title: "T", body: "B" },
          { requires_approval: true, curator_note: { source: "intake" } },
        );
      } finally {
        store.close();
      }
    }
    const store2 = createLibrarianStore({ dataDir });
    const proposalId = store2.listMemories({ status: "proposed" }).memories[0]!.id;
    store2.close();
    const server = await startHttpServer({ dataDir });
    try {
      await expect(trpcPost(server, "examples.distill", { proposalId })).rejects.toThrow(
        /not configured/,
      );
    } finally {
      await server.stop();
    }
  });

  it("distill is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/examples.distill`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ proposalId: "mem_x" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
