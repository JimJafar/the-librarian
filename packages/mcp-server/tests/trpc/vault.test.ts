// Vault explorer/editor tRPC tests (rethink T18/T19, spec §8 / D15).
//
// The dashboard's Obsidian-lite surface: tree (plumbing excluded), read (raw +
// lenient frontmatter + resolved links + backlinks), resolve, and the write
// side — per-kind validation (never write invalid), compare-and-swap saves,
// create/rename/delete with wikilink-integrity rewrites — all admin-gated and
// all landing as git commits through the store layer. Fixture vault is seeded
// on disk (and through the real store for memories) before the server boots.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}
interface ServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGetRaw(server: ServerHandle, proc: string, input?: unknown): Promise<Response> {
  const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  return fetch(`${server.trpcUrl}/trpc/${proc}${query}`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
}

async function trpcGet<T>(server: ServerHandle, proc: string, input?: unknown): Promise<T> {
  const response = await trpcGetRaw(server, proc, input);
  const json = (await response.json()) as TrpcOk<T> | { error: unknown };
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${proc} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPostRaw(server: ServerHandle, proc: string, input: unknown): Promise<Response> {
  return fetch(`${server.trpcUrl}/trpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: JSON.stringify(input),
  });
}

async function trpcPost<T>(server: ServerHandle, proc: string, input: unknown): Promise<T> {
  const response = await trpcPostRaw(server, proc, input);
  const json = (await response.json()) as TrpcOk<T> | { error: unknown };
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc POST ${proc} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

/** The tRPC error body's message + data.code, for asserting teaching errors. */
async function errorOf(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  mtime?: string;
  children?: TreeNode[];
}

interface FileRead {
  path: string;
  kind: string;
  raw: string;
  body: string;
  frontmatter: Record<string, unknown> | null;
  hash: string;
  mtime: string;
  links: { target: string; path: string | null }[];
  backlinks: string[];
}

const flatten = (nodes: TreeNode[]): string[] =>
  nodes.flatMap((node) => [node.path, ...(node.children ? flatten(node.children) : [])]);

const vaultLog = (dataDir: string): string[] =>
  execFileSync("git", ["log", "--format=%s"], {
    cwd: path.join(dataDir, "vault"),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

/** Seed a fixture vault: a memory (via the real store), a reference citing it, primer. */
function seedFixtureVault(dataDir: string): { memoryPath: string; memoryId: string } {
  const seed = createLibrarianStore({ dataDir });
  try {
    const created = seed.createMemory({
      title: "Elaine Piano Teacher",
      body: "Lessons on Tuesdays.",
      agent_id: "agent-x",
    });
    seed.submitToInbox("transient queued note"); // inbox internals must stay hidden
    const memoriesDir = seed.vaultFiles.tree().find((node) => node.path === "memories");
    const memoryPath = memoriesDir?.children?.[0]?.path ?? "";
    seed.vaultFiles.createFile(
      "references/schedule.md",
      "# Schedule\n\nSee [[Elaine Piano Teacher]] for details.\n",
    );
    seed.writePrimer("Recall before answering.");
    return { memoryPath, memoryId: created.memory.id };
  } finally {
    seed.close();
  }
}

describe("tRPC vault explorer/editor (rethink T18/T19, spec §8)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("every procedure is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: the vault
      // surface is served only on the internal listener and 404s on the public
      // port — even for a network agent's bearer (ADR 0008 P1/P3).
      for (const headers of [
        { authorization: "Bearer agent-token" },
        { authorization: "Bearer agent-token" },
      ]) {
        const tree = await fetch(`${server.url}/trpc/vault.tree`, { headers });
        expect(tree.status).toBe(404);
        const write = await fetch(`${server.url}/trpc/vault.write`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ path: "primer.md", raw: "x" }),
        });
        expect(write.status).toBe(404);
      }
    } finally {
      await server.stop();
    }
  });

  it("tree lists the vault (dirs first) and hides .git + inbox internals", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const tree = await trpcGet<TreeNode[]>(server, "vault.tree");
      const paths = flatten(tree);
      expect(paths).toContain("memories");
      expect(paths).toContain("references/schedule.md");
      expect(paths).toContain("primer.md");
      // Plumbing is invisible: git internals and the intake's transient queue.
      expect(paths.some((p) => p === ".git" || p.startsWith(".git/"))).toBe(false);
      expect(paths.some((p) => p === "inbox" || p.startsWith("inbox/"))).toBe(false);
      // Dirs carry children; files carry mtime.
      const primer = tree.find((node) => node.path === "primer.md");
      expect(primer?.type).toBe("file");
      expect(primer?.mtime).toMatch(/^\d{4}-/);
    } finally {
      await server.stop();
    }
  });

  it("read returns raw + frontmatter + hash + resolved links + backlinks", async () => {
    const { memoryPath, memoryId } = seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const memory = await trpcGet<FileRead>(server, "vault.read", { path: memoryPath });
      expect(memory.kind).toBe("memory");
      expect(memory.frontmatter).toMatchObject({ id: memoryId, title: "Elaine Piano Teacher" });
      expect(memory.body).toContain("Lessons on Tuesdays.");
      expect(memory.hash).toMatch(/^[0-9a-f]{64}$/);
      // The reference wikilinks this memory by title → it appears as a backlink.
      expect(memory.backlinks).toEqual(["references/schedule.md"]);

      const reference = await trpcGet<FileRead>(server, "vault.read", {
        path: "references/schedule.md",
      });
      expect(reference.kind).toBe("reference");
      expect(reference.links).toEqual([{ target: "Elaine Piano Teacher", path: memoryPath }]);

      // resolve uses the same alias/slug logic the links use.
      const resolved = await trpcGet<{ path: string | null }>(server, "vault.resolve", {
        target: "Elaine Piano Teacher",
      });
      expect(resolved.path).toBe(memoryPath);
    } finally {
      await server.stop();
    }
  });

  it("rejects path traversal, absolute paths, and plumbing paths on read AND write", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      for (const bad of [
        "../outside.md",
        "/etc/passwd",
        "memories/../../escape.md",
        ".git/config",
        "inbox/raw-item.md",
      ]) {
        const read = await errorOf(await trpcGetRaw(server, "vault.read", { path: bad }));
        expect(read.status, `read ${bad}`).toBeGreaterThanOrEqual(400);
        const write = await errorOf(
          await trpcPostRaw(server, "vault.write", { path: bad, raw: "x" }),
        );
        expect(write.status, `write ${bad}`).toBeGreaterThanOrEqual(400);
      }
      // Nothing escaped the vault.
      expect(fs.existsSync(path.join(dataDir, "escape.md"))).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("refuses to read through a symlink planted inside the vault", async () => {
    seedFixtureVault(dataDir);
    fs.writeFileSync(path.join(dataDir, "outside.md"), "secret outside the vault\n");
    fs.symlinkSync(
      path.join(dataDir, "outside.md"),
      path.join(dataDir, "vault", "references", "sneaky.md"),
    );
    const server = await startHttpServer({ dataDir });
    try {
      const read = await errorOf(
        await trpcGetRaw(server, "vault.read", { path: "references/sneaky.md" }),
      );
      expect(read.status).toBeGreaterThanOrEqual(400);
      expect(read.body).not.toContain("secret outside the vault");
    } finally {
      await server.stop();
    }
  });

  it("write validates per kind: an invalid memory is rejected with the schema errors", async () => {
    const { memoryPath } = seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const before = await trpcGet<FileRead>(server, "vault.read", { path: memoryPath });
      const response = await errorOf(
        await trpcPostRaw(server, "vault.write", { path: memoryPath, raw: "not a memory doc" }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toMatch(/frontmatter/i);
      // Never write invalid: the file is untouched.
      const after = await trpcGet<FileRead>(server, "vault.read", { path: memoryPath });
      expect(after.raw).toBe(before.raw);
    } finally {
      await server.stop();
    }
  });

  it("write validates handoffs (missing heading named) and caps primer/addendums at 2 KB", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      // Handoff missing 'Open questions' → the error names the heading.
      const handoff = await errorOf(
        await trpcPostRaw(server, "vault.create", {
          path: "handoffs/ho_x.md",
          raw: [
            "---",
            'handoff_id: "ho_x"',
            'title: "T"',
            "project_key: null",
            "source_ref: null",
            "cwd: null",
            "created_by_agent_id: null",
            "created_in_harness: null",
            "tags: []",
            'created_at: "2026-06-01T00:00:00.000Z"',
            "claimed_at: null",
            "claimed_by: null",
            "---",
            "## Start & intent\n## Journey\n## Current state\n## What's left",
          ].join("\n"),
        }),
      );
      expect(handoff.status).toBeGreaterThanOrEqual(400);
      expect(handoff.body).toContain("Open questions");

      // Primer over the cap → refused with the byte count; under → accepted.
      const primer = await errorOf(
        await trpcPostRaw(server, "vault.write", { path: "primer.md", raw: "x".repeat(2049) }),
      );
      expect(primer.status).toBeGreaterThanOrEqual(400);
      expect(primer.body).toMatch(/2048/);
      await trpcPost(server, "vault.write", { path: "primer.md", raw: "Short primer." });

      // References are lenient — arbitrary markdown is fine.
      await trpcPost(server, "vault.write", {
        path: "references/schedule.md",
        raw: "totally free-form\n",
      });
    } finally {
      await server.stop();
    }
  });

  it("a save against a changed file conflicts (CAS) — no silent last-write-wins", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const first = await trpcGet<FileRead>(server, "vault.read", {
        path: "references/schedule.md",
      });
      // Someone else saves in between…
      await trpcPost(server, "vault.write", {
        path: "references/schedule.md",
        raw: "# Schedule v2 — someone else\n",
      });
      // …so our stale-hash save is refused with a CONFLICT.
      const conflict = await trpcPostRaw(server, "vault.write", {
        path: "references/schedule.md",
        raw: "# Schedule v2 — me\n",
        expectedHash: first.hash,
      });
      expect((await errorOf(conflict)).status).toBe(409);

      // Reload → retry with the fresh hash succeeds.
      const fresh = await trpcGet<FileRead>(server, "vault.read", {
        path: "references/schedule.md",
      });
      expect(fresh.raw).toBe("# Schedule v2 — someone else\n");
      await trpcPost(server, "vault.write", {
        path: "references/schedule.md",
        raw: "# Schedule v3\n",
        expectedHash: fresh.hash,
      });
    } finally {
      await server.stop();
    }
  });

  it("edits land as git commits and update recall reads (store-layer writes)", async () => {
    const { memoryPath, memoryId } = seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const file = await trpcGet<FileRead>(server, "vault.read", { path: memoryPath });
      await trpcPost(server, "vault.write", {
        path: memoryPath,
        raw: file.raw.replace("Lessons on Tuesdays.", "Lessons moved to Thursdays."),
        expectedHash: file.hash,
      });
      // Visible through the memory surface immediately (index invalidated).
      const memories = await trpcGet<{ memories: { id: string; body: string }[] }>(
        server,
        "memories.list",
        {},
      );
      const edited = memories.memories.find((m) => m.id === memoryId);
      expect(edited?.body).toContain("Thursdays");
    } finally {
      await server.stop();
    }
    expect(vaultLog(dataDir)).toContain(`vault: edit ${memoryPath}`);
  });

  it("create + delete round-trip with commits; create refuses an existing path", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost(server, "vault.create", { path: "references/new-doc.md", raw: "# New\n" });
      const dupe = await trpcPostRaw(server, "vault.create", {
        path: "references/new-doc.md",
        raw: "# Clobber\n",
      });
      expect((await errorOf(dupe)).status).toBe(409);

      await trpcPost(server, "vault.delete", { path: "references/new-doc.md" });
      const gone = await trpcGetRaw(server, "vault.read", { path: "references/new-doc.md" });
      expect(gone.status).toBe(404);
    } finally {
      await server.stop();
    }
    const log = vaultLog(dataDir);
    expect(log).toContain("vault: create references/new-doc.md");
    expect(log).toContain("vault: delete references/new-doc.md");
  });

  it("rename rewrites wikilinks targeting the old filename stem (link integrity)", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost(server, "vault.create", { path: "references/old-name.md", raw: "# Doc\n" });
      await trpcPost(server, "vault.create", {
        path: "references/citing.md",
        raw: "See [[old-name|the doc]].\n",
      });
      const result = await trpcPost<{ path: string; changedLinks: string[] }>(
        server,
        "vault.rename",
        { from: "references/old-name.md", to: "references/new-name.md" },
      );
      expect(result).toEqual({
        path: "references/new-name.md",
        changedLinks: ["references/citing.md"],
      });
      const citing = await trpcGet<FileRead>(server, "vault.read", {
        path: "references/citing.md",
      });
      expect(citing.raw).toContain("[[new-name|the doc]]");
      // The rewritten link resolves to the renamed file.
      expect(citing.links).toEqual([{ target: "new-name", path: "references/new-name.md" }]);
    } finally {
      await server.stop();
    }
    expect(vaultLog(dataDir)).toContain(
      "vault: rename references/old-name.md -> references/new-name.md",
    );
  });
});
