// Curator chat admin tRPC tests (spec 044 PR-6b / Task D6b).
//
// `grooming.chat({ messages, memoryId?, job? })` is a request/response (NO streaming)
// admin endpoint that discusses a memory (or chats generally) with the curator LLM,
// GROUNDED in the memory + its real decision history, and returns prose OR a
// structured proposed action the admin then CONFIRMS (chat never mutates the corpus).
//
// These tests drive a REAL chat turn against a local OpenAI-compatible stub LLM via
// the real HTTP bin; the seed store + server share a runtime-assembled 64-hex master
// key so the chat consumer's provider token round-trips. They pin:
//   - the grounded SYSTEM message reaches the model (memory + its decision history);
//   - a fix-now suggestion maps to a D5 mutation shape AND nothing was written;
//   - the chat uses the `chat` consumer (here via the grooming fallback);
//   - admin-gating.

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  writeConsumerConfig,
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

interface ChatResult {
  kind: string;
  text?: string;
  action?: { type: string; [k: string]: unknown };
  job?: string;
  candidate?: string;
}

// A minimal OpenAI-compatible stub that records every prompt body it sees and
// returns queued completions in order (so a test scripts the model's replies).
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
        const content = completions[i++] ?? JSON.stringify({ kind: "message", text: "ok" });
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

// Seed a store whose `chat` consumer resolves (here via the grooming fallback —
// chat's own provider is left unset, so it inherits grooming's provider+token) and
// one active memory with a recorded grooming decision in its history.
function seed(dataDir: string, stubUrl: string): { memoryId: string } {
  const store = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
  const provider = addProvider(store, {
    name: "stub",
    endpoint: stubUrl,
    token: "dummy-stub-token",
  });
  // Configure ONLY the grooming consumer — chat falls back to it (D6a).
  writeConsumerConfig(store, "grooming", { providerId: provider.id, model: "gpt-x" });

  const created = store.createMemory({
    agent_id: "agent-a",
    title: "Anna — Piano Teacher",
    body: "Anna teaches piano on Tuesdays.",
    category: "people",
    visibility: "common",
    scope: "project",
    project_key: "proj-x",
    priority: "normal",
    confidence: "working",
  }) as unknown as { memory: { id: string } };
  const memoryId = created.memory.id;

  // Record a grooming decision in this memory's history (so grounding has content).
  const run = store.createCurationRun({ trigger: "manual", visibility: "common", input_hash: "h" });
  store.recordCurationOperation({
    run_id: run.id,
    operation_type: "update",
    status: "applied",
    confidence: 0.9,
    rationale: "tightened the title for retrieval",
    proposed_payload: {},
    source_memory_ids: [memoryId],
    target_memory_ids: [memoryId],
  });

  store.close();
  return { memoryId };
}

describe("tRPC grooming.chat (spec 044 D6b)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates grooming.chat (rejected without an admin bearer)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const unauthed = await fetch(`${server.trpcUrl}/trpc/grooming.chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(unauthed.status).toBeGreaterThanOrEqual(400);

      const agent = await fetch(`${server.trpcUrl}/trpc/grooming.chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(agent.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
    }
  });

  it("returns a GROUNDED prose response: the model sees the memory + its decision history", async () => {
    const stub = await startStubLlm([
      JSON.stringify({ kind: "message", text: "I'd keep it as one memory." }),
    ]);
    const { memoryId } = seed(dataDir, stub.url);

    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      const result = await trpcPost<ChatResult>(server, "grooming.chat", {
        messages: [{ role: "user", content: "should this be split?" }],
        memoryId,
      });
      expect(result).toEqual({ kind: "message", text: "I'd keep it as one memory." });
    } finally {
      await server.stop();
      await stub.stop();
    }

    // The grounded prompt reached the model: the memory + its decision history.
    const prompt = stub.prompts[0] ?? "";
    expect(prompt).toContain("Anna — Piano Teacher");
    expect(prompt).toContain("Anna teaches piano on Tuesdays.");
    expect(prompt).toContain("tightened the title for retrieval");
    // No bearer token ever leaks into the prompt body.
    expect(prompt).not.toContain("dummy-stub-token");
  });

  it("returns a proposed_action that maps to a D5 mutation — and writes NOTHING to the corpus", async () => {
    // The stub returns its queued completion regardless of the request, so we can
    // create the store first (to learn the real memory id), then start the stub with
    // a completion that targets that id, then point the consumer at the stub. To do
    // that in one pass we seed with a placeholder stub url first to learn the id, then
    // start the real stub and rewrite the consumer to point at it.
    const placeholder = await startStubLlm([]);
    const { memoryId } = seed(dataDir, placeholder.url);
    await placeholder.stop();

    const stub = await startStubLlm([
      JSON.stringify({
        kind: "proposed_action",
        action: {
          type: "update",
          id: memoryId,
          patch: { title: "Anna — Piano Teacher (Tuesdays)" },
        },
      }),
    ]);
    // Repoint the grooming consumer (which chat falls back to) at the real stub.
    const repoint = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
    const provider = addProvider(repoint, {
      name: "stub2",
      endpoint: stub.url,
      token: "dummy-stub-token",
    });
    writeConsumerConfig(repoint, "grooming", { providerId: provider.id, model: "gpt-x" });
    repoint.close();

    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    let result: ChatResult;
    try {
      result = await trpcPost<ChatResult>(server, "grooming.chat", {
        messages: [{ role: "user", content: "fix the title" }],
        memoryId,
      });
    } finally {
      await server.stop();
      await stub.stop();
    }

    // The proposed action validates against the D5 update shape — confirmable as-is.
    expect(result.kind).toBe("proposed_action");
    expect(result.action?.type).toBe("update");
    expect(result.action?.id).toBe(memoryId);

    // CRUCIAL: chat proposed only — the corpus is UNCHANGED (human-in-the-loop).
    const after = createLibrarianStore({ dataDir });
    try {
      const mem = after.getMemory(memoryId);
      // The title is still the original — chat did NOT apply the proposed update.
      expect(mem?.title).toBe("Anna — Piano Teacher");
      // No new/proposed rows were created by the chat turn.
      expect(after.listAll({ status: "proposed" })).toHaveLength(0);
    } finally {
      after.close();
    }
  });

  it("the proposed_action.action confirms straight to the D5 memoriesRouter.update mutation", async () => {
    const placeholder = await startStubLlm([]);
    const { memoryId } = seed(dataDir, placeholder.url);
    await placeholder.stop();

    const stub = await startStubLlm([
      JSON.stringify({
        kind: "proposed_action",
        action: { type: "update", id: memoryId, patch: { title: "Anna — Piano (Tuesdays)" } },
      }),
    ]);
    const repoint = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
    const provider = addProvider(repoint, {
      name: "stub3",
      endpoint: stub.url,
      token: "dummy-stub-token",
    });
    writeConsumerConfig(repoint, "grooming", { providerId: provider.id, model: "gpt-x" });
    repoint.close();

    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      const proposal = await trpcPost<ChatResult>(server, "grooming.chat", {
        messages: [{ role: "user", content: "fix the title" }],
        memoryId,
      });
      expect(proposal.kind).toBe("proposed_action");
      const action = proposal.action as { type: string; [k: string]: unknown };

      // The dashboard (D7) drops `type` and passes the rest straight to the D5
      // mutation named by `type` — proving the shapes match EXACTLY. The admin's
      // confirmation is what actually mutates the corpus.
      const { type, ...confirmable } = action;
      expect(type).toBe("update");
      const updated = await trpcPost<{ title: string }>(server, "memories.update", confirmable);
      expect(updated.title).toBe("Anna — Piano (Tuesdays)");
    } finally {
      await server.stop();
      await stub.stop();
    }

    // After the ADMIN confirmed, the corpus reflects the change (not from chat).
    const after = createLibrarianStore({ dataDir });
    try {
      expect(after.getMemory(memoryId)?.title).toBe("Anna — Piano (Tuesdays)");
    } finally {
      after.close();
    }
  });

  it("degrades gracefully (no throw) when memoryId points at a missing memory", async () => {
    const stub = await startStubLlm([
      JSON.stringify({ kind: "message", text: "I can't find that memory." }),
    ]);
    seed(dataDir, stub.url);

    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      const result = await trpcPost<ChatResult>(server, "grooming.chat", {
        messages: [{ role: "user", content: "what is this?" }],
        memoryId: "does-not-exist",
      });
      expect(result.kind).toBe("message");
    } finally {
      await server.stop();
      await stub.stop();
    }
  });
});
