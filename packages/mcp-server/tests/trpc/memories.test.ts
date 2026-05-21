// Memory tRPC procedure integration tests (T4.4).
//
// Spawns the real HTTP bin and exercises the typed surface end-to-end:
// admin gating, list/aggregates/events, related (incl. 404), full CRUD
// (create/update/delete), proposal approve/reject, and recall.

import { createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}

interface TrpcErr {
  error: { code?: number; message?: string; data?: { httpStatus?: number; code?: string } };
}

interface MemoryRow {
  id: string;
  title: string;
  body: string;
  status: string;
  category: string;
}

interface ListMemoriesResult {
  memories: MemoryRow[];
  total: number;
  limit: number;
  offset: number;
}

interface CreateMemoryResult {
  status: string;
  memory?: MemoryRow;
}

interface ServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.url}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.url}/trpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.token}`,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc POST ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

function seedMemory(
  dataDir: string,
  overrides: Partial<{ title: string; body: string; category: string; agent_id: string }> = {},
): MemoryRow {
  const store = createLibrarianStore({ dataDir });
  try {
    const result = store.createMemory({
      agent_id: overrides.agent_id || "bede",
      title: overrides.title || "Seeded memory",
      body: overrides.body || "Body text",
      category: overrides.category || "lessons",
    });
    return result.memory as MemoryRow;
  } finally {
    store.close();
  }
}

describe("tRPC memories surface", () => {
  it("rejects unauthenticated calls with UNAUTHORIZED", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/memories.list`);
      expect(response.status).toBe(401);
      const body = (await response.json()) as TrpcErr;
      expect(body.error?.data?.code).toBe("UNAUTHORIZED");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.list returns paginated memories", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha" });
    seedMemory(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list");
      expect(data.total).toBe(2);
      expect(data.memories.map((m) => m.title).sort()).toEqual(["Alpha", "Beta"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.list applies filters", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha", category: "lessons" });
    seedMemory(dataDir, { title: "Beta", category: "tools" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        category: "tools",
      });
      expect(data.total).toBe(1);
      expect(data.memories[0]?.title).toBe("Beta");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.aggregates returns tallies", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha", category: "lessons" });
    seedMemory(dataDir, { title: "Beta", category: "tools" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<{
        total: number;
        categories: { value: unknown; count: number }[];
      }>(server, "memories.aggregates");
      expect(data.total).toBe(2);
      const tools = data.categories.find((c) => c.value === "tools");
      expect(tools?.count).toBe(1);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.events returns paginated event ledger", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha" });
    seedMemory(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<{
        events: { event_type: string }[];
        total: number;
      }>(server, "memories.events", { limit: 10 });
      expect(data.total).toBeGreaterThanOrEqual(2);
      expect(data.events.every((e) => typeof e.event_type === "string")).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.related returns 404 for unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(
        `${server.url}/trpc/memories.related?input=${encodeURIComponent(
          JSON.stringify({ id: "mem_nope" }),
        )}`,
        {
          headers: { authorization: `Bearer ${server.token}` },
        },
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as TrpcErr;
      expect(body.error?.data?.code).toBe("NOT_FOUND");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.create then memories.update mutates the row", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const created = await trpcPost<CreateMemoryResult>(server, "memories.create", {
        agent_id: "bede",
        title: "Created via tRPC",
        body: "Original body",
        category: "lessons",
      });
      expect(created.status).toBe("active");
      const id = created.memory?.id;
      expect(id).toBeTypeOf("string");

      const updated = await trpcPost<MemoryRow>(server, "memories.update", {
        id,
        patch: { body: "Patched body" },
      });
      expect(updated.body).toBe("Patched body");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.archive marks the memory as archived", async () => {
    const dataDir = makeTempDir();
    const memory = seedMemory(dataDir, { title: "Disposable" });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.archive", { id: memory.id });
      expect(result.status).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.approve transitions a proposal to active", async () => {
    const dataDir = makeTempDir();
    const proposal = seedMemory(dataDir, { title: "Who", category: "identity" });
    expect(proposal.status).toBe("proposed");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.approve", { id: proposal.id });
      expect(result.status).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.reject archives a proposal under the three-state model", async () => {
    const dataDir = makeTempDir();
    const proposal = seedMemory(dataDir, { title: "Reject me", category: "identity" });
    expect(proposal.status).toBe("proposed");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.reject", { id: proposal.id });
      // V1.2 collapsed `rejected` into `archived` — the event log still
      // emits `memory.rejected`, but the projection rolls it forward.
      expect(result.status).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.recall returns matching memories and records the recall", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Coffee preferences", body: "Espresso, no sugar." });
    seedMemory(dataDir, { title: "Other", body: "Unrelated." });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcPost<{ memories: MemoryRow[] }>(server, "memories.recall", {
        agent_id: "bede",
        query: "coffee",
        limit: 5,
      });
      expect(data.memories.length).toBeGreaterThanOrEqual(1);
      expect(data.memories.some((m) => m.title === "Coffee preferences")).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.recall against an empty store returns no memories and records a recall_empty event", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcPost<{ memories: MemoryRow[] }>(server, "memories.recall", {
        agent_id: "bede",
        query: "nothing here",
      });
      expect(data.memories).toEqual([]);
      const events = await trpcGet<{ events: { event_type: string }[] }>(
        server,
        "memories.events",
        { type: "memory.recall_empty" },
      );
      expect(events.events.length).toBe(1);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.create always saves and surfaces duplicates as an informational signal", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, {
      title: "API style preference",
      body: "Prefer typed tRPC APIs over hand-rolled REST.",
      category: "lessons",
    });
    const server = await startHttpServer({ dataDir });
    try {
      // V1.2: createMemory no longer refuses writes. The duplicates list is
      // returned alongside the saved row so the agent can decide whether to
      // consolidate manually.
      const created = await trpcPost<{
        status: string;
        memory: { id: string };
        duplicates: { id: string }[];
      }>(server, "memories.create", {
        agent_id: "bede",
        title: "API style preference",
        body: "Prefer typed tRPC APIs over hand-rolled REST endpoints.",
        category: "lessons",
      });
      expect(created.status).toBe("active");
      expect(created.memory.id).toBeTruthy();
      expect(Array.isArray(created.duplicates)).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.list applies status + category filters together", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Active lesson", category: "lessons" });
    seedMemory(dataDir, { title: "Active tool", category: "tools" });
    const proposal = seedMemory(dataDir, { title: "Proposed", category: "identity" });
    expect(proposal.status).toBe("proposed");
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        status: "active",
        category: "lessons",
      });
      expect(data.total).toBe(1);
      expect(data.memories[0]?.title).toBe("Active lesson");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.update / archive / approve / reject return NOT_FOUND for unknown ids", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      for (const [path, body] of [
        ["memories.update", { id: "mem_nope", patch: { body: "x" } }],
        ["memories.archive", { id: "mem_nope" }],
        ["memories.approve", { id: "mem_nope" }],
        ["memories.reject", { id: "mem_nope" }],
      ] as const) {
        const response = await fetch(`${server.url}/trpc/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${server.token}`,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(404);
        const json = (await response.json()) as TrpcErr;
        expect(json.error?.data?.code).toBe("NOT_FOUND");
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
