// Per-file history / diff / restore tRPC tests (rethink T20, spec §8 / D16).
//
// The vault router's git-history surface: commit lists per file, content at a
// commit, unified diffs, and restore-as-a-NEW-commit through the validated
// store write path — admin-gated like the sibling procedures, with teaching
// refusals for invalid hashes and for versions that no longer validate.

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

interface FileCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
  path: string;
}

const vaultLog = (dataDir: string): string[] =>
  execFileSync("git", ["log", "--format=%s"], {
    cwd: path.join(dataDir, "vault"),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

/** Seed a reference with two committed versions + a legacy-invalid memory. */
function seedFixtureVault(dataDir: string): void {
  const seed = createLibrarianStore({ dataDir });
  try {
    seed.vaultFiles.createFile("references/doc.md", "# Doc v1\n");
    seed.vaultFiles.writeFile("references/doc.md", "# Doc v2\n");
    // A legacy memory version that predates frontmatter validation, committed
    // outside the store (the store itself never writes invalid)…
    fs.writeFileSync(path.join(dataDir, "vault", "memories", "legacy.md"), "no frontmatter\n");
    execFileSync("git", ["add", "-A"], { cwd: path.join(dataDir, "vault") });
    execFileSync("git", ["commit", "-m", "legacy import"], { cwd: path.join(dataDir, "vault") });
  } finally {
    seed.close();
  }
}

describe("tRPC vault history/diff/restore (rethink T20, spec §8)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
    fs.mkdirSync(path.join(dataDir, "vault", "memories"), { recursive: true });
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates the history surface (anonymous and agent bearers rejected)", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      for (const headers of [{}, { authorization: "Bearer agent-token" }]) {
        const input = encodeURIComponent(JSON.stringify({ path: "references/doc.md" }));
        const history = await fetch(`${server.trpcUrl}/trpc/vault.history?input=${input}`, {
          headers,
        });
        expect(history.status).toBeGreaterThanOrEqual(400);
        const restore = await fetch(`${server.trpcUrl}/trpc/vault.restoreVersion`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ path: "references/doc.md", hash: "a".repeat(40) }),
        });
        expect(restore.status).toBeGreaterThanOrEqual(400);
      }
    } finally {
      await server.stop();
    }
  });

  it("history lists a file's commits newest-first; atCommit + diff serve any version", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const history = await trpcGet<FileCommit[]>(server, "vault.history", {
        path: "references/doc.md",
      });
      expect(history.map((c) => c.subject)).toEqual([
        "vault: edit references/doc.md",
        "vault: create references/doc.md",
      ]);
      expect(history[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(history[0]?.date).toMatch(/^\d{4}-/);

      const v1 = await trpcGet<{ content: string }>(server, "vault.atCommit", {
        path: "references/doc.md",
        hash: history[1]!.hash,
      });
      expect(v1.content).toBe("# Doc v1\n");

      const { diff } = await trpcGet<{ diff: string }>(server, "vault.diff", {
        path: "references/doc.md",
        from: history[1]!.hash,
        to: history[0]!.hash,
      });
      expect(diff).toContain("-# Doc v1");
      expect(diff).toContain("+# Doc v2");
    } finally {
      await server.stop();
    }
  });

  it("rejects a malformed hash with a teaching message (never reaches git)", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const response = await trpcGetRaw(server, "vault.atCommit", {
        path: "references/doc.md",
        hash: "--exec=true",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).toContain("git commit hash");
    } finally {
      await server.stop();
    }
  });

  it("restoreVersion writes the chosen version as a NEW commit and refreshes recall reads", async () => {
    seedFixtureVault(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const history = await trpcGet<FileCommit[]>(server, "vault.history", {
        path: "references/doc.md",
      });
      const target = history[1]!;
      await trpcPost(server, "vault.restoreVersion", {
        path: "references/doc.md",
        hash: target.hash,
      });
      const file = await trpcGet<{ raw: string }>(server, "vault.read", {
        path: "references/doc.md",
      });
      expect(file.raw).toBe("# Doc v1\n");
    } finally {
      await server.stop();
    }
    // A new head commit — history grew, nothing was rewritten.
    const log = vaultLog(dataDir);
    expect(log[0]).toMatch(/^vault: restore references\/doc\.md to [0-9a-f]{12}$/);
    expect(log).toContain("vault: edit references/doc.md");
  });

  it("refuses to restore a version that fails current validation, teaching the manual path", async () => {
    seedFixtureVault(dataDir);
    // Bring the legacy memory up to a valid shape through the store.
    const seed = createLibrarianStore({ dataDir });
    const valid = [
      "---",
      'id: "mem_abc12345"',
      'title: "Legacy"',
      'agent_id: "agent-x"',
      'status: "active"',
      "project_key: null",
      'priority: "normal"',
      'confidence: "medium"',
      "tags: []",
      "applies_to: []",
      "supersedes: []",
      "conflicts_with: []",
      "flags: []",
      "recall_count: 0",
      "usefulness_score: 0",
      "is_global: false",
      "requires_approval: false",
      'created_at: "2026-06-01T00:00:00.000Z"',
      'updated_at: "2026-06-01T00:00:00.000Z"',
      "curator_note: null",
      "---",
      "",
      "Valid now.",
      "",
    ].join("\n");
    seed.vaultFiles.writeFile("memories/legacy.md", valid);
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const history = await trpcGet<FileCommit[]>(server, "vault.history", {
        path: "memories/legacy.md",
      });
      const legacy = history.find((c) => c.subject === "legacy import")!;
      const response = await trpcPostRaw(server, "vault.restoreVersion", {
        path: "memories/legacy.md",
        hash: legacy.hash,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/bring the old content forward manually/);
      // The refused restore wrote nothing.
      const file = await trpcGet<{ raw: string }>(server, "vault.read", {
        path: "memories/legacy.md",
      });
      expect(file.raw).toBe(valid);
    } finally {
      await server.stop();
    }
  });
});
