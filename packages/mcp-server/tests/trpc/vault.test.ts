// Vault explorer tRPC tests (rethink T18, spec §8 / D15).
//
// The dashboard's Obsidian-lite read surface: tree (plumbing excluded), read
// (raw + lenient frontmatter + resolved links + backlinks) and resolve — all
// admin-gated, with path traversal/symlink tricks rejected. Fixture vault is
// seeded on disk (and through the real store for memories) before the server
// boots. The write side (T19) extends this file.

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
  return fetch(`${server.url}/trpc/${proc}${query}`, {
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

/** The tRPC error body's status + text, for asserting teaching errors. */
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

/** Seed a fixture vault: a memory (via the real store), a reference citing it, primer. */
function seedFixtureVault(dataDir: string): { memoryPath: string; memoryId: string } {
  const seed = createLibrarianStore({ dataDir });
  try {
    const created = seed.createMemory({
      title: "Anna Piano Teacher",
      body: "Lessons on Tuesdays.",
      agent_id: "agent-x",
    });
    seed.submitToInbox("transient queued note"); // inbox internals must stay hidden
    const memoriesDir = seed.vaultFiles.tree().find((node) => node.path === "memories");
    const memoryPath = memoriesDir?.children?.[0]?.path ?? "";
    seed.vaultFiles.createFile(
      "references/schedule.md",
      "# Schedule\n\nSee [[Anna Piano Teacher]] for details.\n",
    );
    seed.writePrimer("Recall before answering.");
    return { memoryPath, memoryId: created.memory.id };
  } finally {
    seed.close();
  }
}

describe("tRPC vault explorer (rethink T18, spec §8)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates every procedure (anonymous and agent bearers rejected)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      for (const headers of [{}, { authorization: "Bearer agent-token" }]) {
        const tree = await fetch(`${server.url}/trpc/vault.tree`, { headers });
        expect(tree.status).toBeGreaterThanOrEqual(400);
        const read = await fetch(
          `${server.url}/trpc/vault.read?input=${encodeURIComponent(
            JSON.stringify({ path: "primer.md" }),
          )}`,
          { headers },
        );
        expect(read.status).toBeGreaterThanOrEqual(400);
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
      expect(memory.frontmatter).toMatchObject({ id: memoryId, title: "Anna Piano Teacher" });
      expect(memory.body).toContain("Lessons on Tuesdays.");
      expect(memory.hash).toMatch(/^[0-9a-f]{64}$/);
      // The reference wikilinks this memory by title → it appears as a backlink.
      expect(memory.backlinks).toEqual(["references/schedule.md"]);

      const reference = await trpcGet<FileRead>(server, "vault.read", {
        path: "references/schedule.md",
      });
      expect(reference.kind).toBe("reference");
      expect(reference.links).toEqual([{ target: "Anna Piano Teacher", path: memoryPath }]);

      // resolve uses the same alias/slug logic the links use.
      const resolved = await trpcGet<{ path: string | null }>(server, "vault.resolve", {
        target: "Anna Piano Teacher",
      });
      expect(resolved.path).toBe(memoryPath);
    } finally {
      await server.stop();
    }
  });

  it("rejects path traversal, absolute paths, and plumbing paths", async () => {
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
});
