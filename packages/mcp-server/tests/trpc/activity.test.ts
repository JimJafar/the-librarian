// Vault activity feed + guarded whole-vault restore tRPC tests (rethink T21,
// spec §8 / D16). The feed is the audit trail (provenance derived from the
// commit-subject conventions, replacing the retired event ledger's logs
// view); the restore is gated on the server-validated typed confirmation,
// leaves a pre-restore tag, and lands as ONE new commit.

import { execFileSync } from "node:child_process";
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

async function trpcGet<T>(server: ServerHandle, proc: string, input?: unknown): Promise<T> {
  const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await fetch(`${server.url}/trpc/${proc}${query}`, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | { error: unknown };
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${proc} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPostRaw(server: ServerHandle, proc: string, input: unknown): Promise<Response> {
  return fetch(`${server.url}/trpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: JSON.stringify(input),
  });
}

interface ActivityEntry {
  hash: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
  source: string;
}

const vaultGit = (dataDir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: path.join(dataDir, "vault"), encoding: "utf8" }).trim();

/** Seed commits with distinct provenance: admin (vault:), agent (inbox: submit). */
function seedFixtureVault(dataDir: string): void {
  const seed = createLibrarianStore({ dataDir });
  try {
    seed.vaultFiles.createFile("references/doc.md", "# Doc v1\n");
    seed.vaultFiles.writeFile("references/doc.md", "# Doc v2\n");
    seed.submitToInbox("an agent remembered something");
  } finally {
    seed.close();
  }
}

describe("tRPC vault activity + whole-vault restore (rethink T21, spec §8)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
    seedFixtureVault(dataDir);
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("admin-gates the feed and the restore", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      for (const headers of [{}, { authorization: "Bearer agent-token" }]) {
        const feed = await fetch(`${server.url}/trpc/activity.feed`, { headers });
        expect(feed.status).toBeGreaterThanOrEqual(400);
        const restore = await fetch(`${server.url}/trpc/activity.restoreVault`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ hash: "a".repeat(40), confirm: "RESTORE" }),
        });
        expect(restore.status).toBeGreaterThanOrEqual(400);
      }
    } finally {
      await server.stop();
    }
  });

  it("feed lists vault commits newest-first with files + provenance source", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const feed = await trpcGet<ActivityEntry[]>(server, "activity.feed");
      expect(feed.length).toBeGreaterThanOrEqual(3);
      // Newest-first: the agent's inbox submit (seeded last) precedes the edit.
      // (Boot itself may commit on top — e.g. the primer seed — so search, don't index.)
      const submit = feed.find((c) => c.subject.startsWith("inbox: submit "))!;
      expect(submit.source).toBe("agent");
      const edit = feed.find((c) => c.subject === "vault: edit references/doc.md")!;
      expect(feed.indexOf(submit)).toBeLessThan(feed.indexOf(edit));
      expect(edit.source).toBe("admin");
      expect(edit.files).toEqual(["references/doc.md"]);
      // limit pages the feed.
      expect(await trpcGet<ActivityEntry[]>(server, "activity.feed", { limit: 1 })).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("rejects a restore without the exact confirmation phrase (server-validated)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const feed = await trpcGet<ActivityEntry[]>(server, "activity.feed");
      for (const confirm of ["", "restore", "RESTORE ", "yes"]) {
        const response = await trpcPostRaw(server, "activity.restoreVault", {
          hash: feed[1]!.hash,
          confirm,
        });
        expect(response.status, `confirm='${confirm}'`).toBe(400);
        expect(await response.text()).toContain("confirmation phrase");
      }
      // Nothing was restored.
      expect(vaultGit(dataDir, "log", "-1", "--format=%s")).not.toMatch(/^vault: restore to/);
    } finally {
      await server.stop();
    }
  });

  it("restores the vault to a commit: pre-restore tag + ONE new commit, no rewrite", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const feed = await trpcGet<ActivityEntry[]>(server, "activity.feed");
      const target = feed.find((c) => c.subject === "vault: create references/doc.md")!;
      const headBefore = vaultGit(dataDir, "rev-parse", "HEAD");

      const response = await trpcPostRaw(server, "activity.restoreVault", {
        hash: target.hash,
        confirm: "RESTORE",
      });
      expect(response.status).toBe(200);
      const { result } = (await response.json()) as TrpcOk<{
        restoredTo: string;
        preRestoreTag: string;
        commit: string | null;
      }>;
      expect(result.data.restoredTo).toBe(target.hash);
      expect(result.data.preRestoreTag).toMatch(/^pre-restore-\d{8}-\d{6}$/);
      // The tag anchors the pre-restore HEAD; the restore is one new commit on top.
      expect(vaultGit(dataDir, "rev-parse", `${result.data.preRestoreTag}^{commit}`)).toBe(
        headBefore,
      );
      expect(vaultGit(dataDir, "log", "-1", "--format=%s")).toBe(
        `vault: restore to ${target.hash}`,
      );
      // The restored tree serves through the vault surface (index invalidated).
      const file = await trpcGet<{ raw: string }>(server, "vault.read", {
        path: "references/doc.md",
      });
      expect(file.raw).toBe("# Doc v1\n");
    } finally {
      await server.stop();
    }
  });

  it("404s a hash that names no commit", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const response = await trpcPostRaw(server, "activity.restoreVault", {
        hash: "deadbeef".repeat(5),
        confirm: "RESTORE",
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("activity feed");
    } finally {
      await server.stop();
    }
  });
});
