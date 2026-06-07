// Memory tRPC procedure integration tests (T4.4).
//
// Spawns the real HTTP bin and exercises the typed surface end-to-end:
// admin gating, list/aggregates, related (incl. 404), full CRUD
// (create/update/delete), proposal approve/reject, and recall.

import { spawnSync } from "node:child_process";
import { createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// The data dir's vault is a git repo; every store mutation lands a commit. Read
// the subject lines so a test can assert a mutation was committed (revertable).
function gitLog(dataDir: string): string[] {
  const result = spawnSync("git", ["-C", `${dataDir}/vault`, "log", "--format=%s"], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

// Read a memory's curator_note (the provenance record) from the data dir, by
// opening a fresh store — the HTTP server runs in a separate process.
function curatorNote(dataDir: string, id: string): Record<string, unknown> | null | undefined {
  const store = createLibrarianStore({ dataDir });
  try {
    return store.getMemory(id)?.curator_note as Record<string, unknown> | null | undefined;
  } finally {
    store.close();
  }
}

function memoryStatus(dataDir: string, id: string): string | undefined {
  const store = createLibrarianStore({ dataDir });
  try {
    return store.getMemory(id)?.status;
  } finally {
    store.close();
  }
}

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
  overrides: Partial<{
    title: string;
    body: string;
    category: string;
    agent_id: string;
    requires_approval: boolean;
  }> = {},
): MemoryRow {
  const store = createLibrarianStore({ dataDir });
  try {
    const opts: Record<string, unknown> = {};
    if (overrides.requires_approval === true) opts.requires_approval = true;
    const result = store.createMemory(
      {
        agent_id: overrides.agent_id || "bede",
        title: overrides.title || "Seeded memory",
        body: overrides.body || "Body text",
        category: overrides.category || "lessons",
      },
      opts,
    );
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

  it("memories.list applies status filters (Section 4d.3 — category filter retired)", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha" });
    seedMemory(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        status: "active",
      });
      expect(data.total).toBe(2);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.aggregates returns tallies", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha" });
    seedMemory(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<{
        total: number;
        agents: { value: unknown; count: number }[];
      }>(server, "memories.aggregates");
      expect(data.total).toBe(2);
      expect(Array.isArray(data.agents)).toBe(true);
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
    const proposal = seedMemory(dataDir, {
      title: "Who",
      category: "identity",
      requires_approval: true,
    });
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
    const proposal = seedMemory(dataDir, {
      title: "Reject me",
      category: "identity",
      requires_approval: true,
    });
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

  it("memories.recall against an empty store returns no memories", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcPost<{ memories: MemoryRow[] }>(server, "memories.recall", {
        agent_id: "bede",
        query: "nothing here",
      });
      expect(data.memories).toEqual([]);
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
      // file manually.
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

  it("memories.list applies status filter, ignoring legacy category param (Section 4d.3)", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Active lesson" });
    seedMemory(dataDir, { title: "Active tool" });
    const proposal = seedMemory(dataDir, {
      title: "Proposed",
      requires_approval: true,
    });
    expect(proposal.status).toBe("proposed");
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        status: "active",
      });
      // The status=active filter returns both active rows; the category
      // parameter is accepted but has no effect (column dropped).
      expect(data.total).toBe(2);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.bulkUpdate re-homes a set of memories with one round-trip (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const a = seedMemory(dataDir, { title: "A", category: "projects" });
      const b = seedMemory(dataDir, { title: "B", category: "projects" });
      const c = seedMemory(dataDir, { title: "C", category: "projects" });
      const result = await trpcPost<{ transaction_id: string; updated: number }>(
        server,
        "memories.bulkUpdate",
        { ids: [a.id, b.id, c.id], patch: { project_key: "new-home" } },
      );
      expect(result.updated).toBe(3);
      expect(result.transaction_id).toMatch(/^txn_/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.bulkUpdate rejects an empty patch (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const m = seedMemory(dataDir, { title: "X" });
      const response = await fetch(`${server.url}/trpc/memories.bulkUpdate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ ids: [m.id], patch: {} }),
      });
      expect(response.status).toBe(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.distinctValues returns deduplicated values for the named field (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      seedMemory(dataDir, { agent_id: "alpha" });
      seedMemory(dataDir, { agent_id: "alpha" });
      seedMemory(dataDir, { agent_id: "beta" });
      const values = await trpcGet<string[]>(server, "memories.distinctValues", {
        field: "agent_id",
      });
      expect([...values].sort()).toEqual(["alpha", "beta"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.distinctValues rejects fields outside the whitelist (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const url = new URL(`${server.url}/trpc/memories.distinctValues`);
      url.searchParams.set("input", JSON.stringify({ field: "body" }));
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(response.status).toBe(400);
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

// Admin mutation primitives (spec 044 D-5a). merge/split/update run OUTSIDE a
// curation run (an admin fixing the corpus directly), call the SAME shared store
// primitives the curator run path uses, tag provenance `curator_note.source =
// "admin-chat"`, and each lands a git commit (revertable). Admin-gated.
describe("tRPC admin mutation primitives (spec 044 D-5a)", () => {
  it("memories.merge merges N sources into one target, tags admin-chat, commits", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Dup A", body: "same fact" });
    const b = seedMemory(dataDir, { title: "Dup B", body: "same fact" });
    const server = await startHttpServer({ dataDir });
    try {
      const merged = await trpcPost<MemoryRow>(server, "memories.merge", {
        source_ids: [a.id, b.id],
        replacement: { title: "Merged fact", body: "the merged fact", category: "lessons" },
      });
      expect(merged.title).toBe("Merged fact");
      expect(merged.status).toBe("active");
      // Sources archived (an admin merge auto-applies — there's no run to defer to).
      expect(memoryStatus(dataDir, a.id)).toBe("archived");
      expect(memoryStatus(dataDir, b.id)).toBe("archived");
      // Provenance: supersedes the sources + tagged admin-chat.
      const note = curatorNote(dataDir, merged.id);
      expect(note?.supersedes).toEqual([a.id, b.id]);
      expect(note?.source).toBe("admin-chat");
      // Committed (revertable): the create + both archives are in git history.
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`store ${merged.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`archive ${a.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`archive ${b.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.split spins one source into N replacements, tags admin-chat, commits", async () => {
    const dataDir = makeTempDir();
    const src = seedMemory(dataDir, { title: "Overloaded", body: "facts about Anna and Bob" });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ ids: string[] }>(server, "memories.split", {
        source_id: src.id,
        replacements: [
          { title: "Anna", body: "about Anna", category: "lessons" },
          { title: "Bob", body: "about Bob", category: "lessons" },
        ],
      });
      expect(result.ids).toHaveLength(2);
      // Source archived (an admin split auto-applies).
      expect(memoryStatus(dataDir, src.id)).toBe("archived");
      for (const id of result.ids) {
        expect(memoryStatus(dataDir, id)).toBe("active");
        const note = curatorNote(dataDir, id);
        expect(note?.supersedes).toEqual([src.id]);
        expect(note?.source).toBe("admin-chat");
      }
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`archive ${src.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.update patches a memory in place (the shared update routine), commits", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Stale", body: "old body" });
    const server = await startHttpServer({ dataDir });
    try {
      const updated = await trpcPost<MemoryRow>(server, "memories.update", {
        id: m.id,
        patch: { body: "corrected body" },
      });
      expect(updated.body).toBe("corrected body");
      expect(updated.status).toBe("active"); // in place, not superseded
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`update ${m.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("merge / split reject unauthenticated callers (admin-gated)", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Protected by gate" });
    const server = await startHttpServer({ dataDir });
    try {
      for (const [path, body] of [
        ["memories.merge", { source_ids: [m.id, m.id], replacement: { title: "X", body: "y" } }],
        ["memories.split", { source_id: m.id, replacements: [{ title: "A" }, { title: "B" }] }],
      ] as const) {
        const response = await fetch(`${server.url}/trpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(401);
        const json = (await response.json()) as TrpcErr;
        expect(json.error?.data?.code).toBe("UNAUTHORIZED");
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// unmerge / reverse-a-groom (spec 044 D-5b). Given a merged target, read its
// curator_note.supersedes (the source ids it replaced), un-archive those sources
// (restore them to active), and archive the merged target — reversing a bad merge.
// Restore-sources-before-archive-target is the data-loss-safe ordering. Each
// transition lands a git commit (revertable). Admin-gated.
describe("tRPC unmerge / reverse-a-groom (spec 044 D-5b)", () => {
  it("reverses a merge: restores the sources to active and archives the target", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Dup A", body: "same fact" });
    const b = seedMemory(dataDir, { title: "Dup B", body: "same fact" });
    const server = await startHttpServer({ dataDir });
    try {
      // Merge first (the bad merge): sources archived, target active.
      const merged = await trpcPost<MemoryRow>(server, "memories.merge", {
        source_ids: [a.id, b.id],
        replacement: { title: "Merged fact", body: "the merged fact", category: "lessons" },
      });
      expect(memoryStatus(dataDir, a.id)).toBe("archived");
      expect(memoryStatus(dataDir, b.id)).toBe("archived");
      expect(memoryStatus(dataDir, merged.id)).toBe("active");

      // Now unmerge it.
      const result = await trpcPost<{ restored: string[]; archived: string }>(
        server,
        "memories.unmerge",
        { id: merged.id },
      );
      expect(result.restored).toEqual([a.id, b.id]);
      expect(result.archived).toBe(merged.id);

      // Sources are active again; the merged target is archived.
      expect(memoryStatus(dataDir, a.id)).toBe("active");
      expect(memoryStatus(dataDir, b.id)).toBe("active");
      expect(memoryStatus(dataDir, merged.id)).toBe("archived");

      // Each transition is committed (revertable): the un-archives, then the archive.
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`unarchive ${a.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`unarchive ${b.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`archive ${merged.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("restores sources BEFORE archiving the target (no data loss on partial failure)", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Dup A", body: "same fact" });
    const b = seedMemory(dataDir, { title: "Dup B", body: "same fact" });
    const server = await startHttpServer({ dataDir });
    try {
      const merged = await trpcPost<MemoryRow>(server, "memories.merge", {
        source_ids: [a.id, b.id],
        replacement: { title: "Merged fact", body: "the merged fact", category: "lessons" },
      });
      await trpcPost(server, "memories.unmerge", { id: merged.id });
      // The data-loss-safe invariant: at no point are ALL of {sources, target}
      // archived. After unmerge the sources are restored; even if the final
      // archive of the target had failed, the sources would already be active —
      // so a partial failure can never leave the whole group archived.
      const sourcesActive =
        memoryStatus(dataDir, a.id) === "active" && memoryStatus(dataDir, b.id) === "active";
      expect(sourcesActive).toBe(true);
      // The un-archive commits land before the target's archive commit (ordering).
      const log = gitLog(dataDir); // newest-first
      const archiveTargetIdx = log.findIndex((s) => s.includes(`archive ${merged.id}`));
      const unarchiveAIdx = log.findIndex((s) => s.includes(`unarchive ${a.id}`));
      const unarchiveBIdx = log.findIndex((s) => s.includes(`unarchive ${b.id}`));
      // newest-first → a smaller index is a LATER commit; the target archive is
      // the newest of the three (smallest index).
      expect(archiveTargetIdx).toBeLessThan(unarchiveAIdx);
      expect(archiveTargetIdx).toBeLessThan(unarchiveBIdx);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns a clear error for a memory with no superseded sources (not a merge result)", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Plain memory", body: "not a merge result" });
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/memories.unmerge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ id: m.id }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.message).toMatch(/not a merge result|no superseded sources/i);
      // No corpus change: the memory is untouched (still active).
      expect(memoryStatus(dataDir, m.id)).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns NOT_FOUND for an unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/memories.unmerge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ id: "mem_does_not_exist" }),
      });
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.data?.code).toBe("NOT_FOUND");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects unauthenticated callers (admin-gated)", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Protected by gate" });
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/memories.unmerge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: m.id }),
      });
      expect(response.status).toBe(401);
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.data?.code).toBe("UNAUTHORIZED");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
