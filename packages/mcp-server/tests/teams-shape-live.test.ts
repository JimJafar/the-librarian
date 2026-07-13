// Spec 062 SC 9 — the Teams shape works end to end, over real HTTP through the 060 factory.
//
// ONE integration test composing the FULL stack via a single plugin that fills BOTH provider
// seams: a member-aware AuthProvider (061-style: bearer → member principal) AND a VaultRouter that
// maps the member to `[ members/x/ (writable, "Sarah's shelf"), team/ (read-only, "Team library") ]`
// with `writeTarget = members/x/`. Driven over ephemeral loopback ports (`port: 0`) on the same
// `internals.publicServer` infrastructure the 060 / 061 e2e suites use. It pins, in order:
//
//   (1) the member's MCP `remember` lands under `members/x/memories/…`, frontmatter actor = the
//       member's actorId (asserted from the file);
//   (2) the member's MCP `recall` returns LABELLED hits from BOTH shelves — the formatted text
//       carries `[Sarah's shelf (members/x)]` and `[Team library (team)]`, interleaved with the
//       personal (higher-precedence) shelf first (the merge rule);
//   (3) a write routed to the READ-ONLY team shelf (a second principal whose `writeTarget` is the
//       team shelf) surfaces the typed-error mapping as a CLEAN JSON-RPC error (code -32000, not a
//       500 crash), and nothing lands on the team shelf;
//   (4) a backup + restore round-trip on the SHELVED vault: a real `git push` to a local bare
//       remote, a real clone into the restore-staging dir, then the REAL `applyPendingRestore` —
//       whose vault detection (`isLibrarianVault`) now recognises the shelf-prefixed layout (spec
//       062 T7; the pre-T7 root-only check rejected exactly this tree). After restore, BOTH shelves'
//       files are intact AND a post-restore recall still returns both shelves' labelled hits.
//
// Imports the compiled artifact (../dist), like librarian-server.test.ts / provider-seam-live.test.ts.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type Principal,
  type Shelf,
  type VaultRouter,
  RESTORE_MARKER,
  applyPendingRestore,
  cloneVaultBackup,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import type { AuthProvider } from "../dist/http/auth.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import type { LibrarianPlugin } from "../dist/plugin.js";

const MEMBER_BEARER = "Bearer sarah-secret"; // Sarah — writes to members/x/, recalls both shelves
const INTRUDER_BEARER = "Bearer bob-secret"; // Bob — routed to the read-only team shelf for writes

// The Teams-shape shelves. `personal.id` is "members/x" so the recall token reads
// `[Sarah's shelf (members/x)]`; `team` is read-only and labelled "Team library".
const personal: Shelf = {
  id: "members/x",
  prefix: "members/x/",
  writable: true,
  label: "Sarah's shelf",
};
const team: Shelf = { id: "team", prefix: "team/", writable: false, label: "Team library" };

// The two member principals the provider resolves. Sarah's `boundActorId` is her cryptographic
// binding, so — with no body `agent_id` — it wins for attribution and lands in frontmatter as
// `member-sarah` (resolveCaller normalises it; no colon to rewrite here).
const sarah: Principal = {
  kind: "member",
  actorId: "member-sarah",
  boundActorId: "member-sarah",
  roles: ["agent"],
  scope: "agent",
  attrs: { memberId: "sarah" },
};
const bob: Principal = {
  kind: "member",
  actorId: "member-bob",
  boundActorId: "member-bob",
  roles: ["agent"],
  scope: "agent",
  attrs: { memberId: "bob" },
};

// A member-aware AuthProvider (061 seam): bearer → member principal; internal → admin-by-isolation;
// anything else → 401.
const memberAuth: AuthProvider = {
  async authenticate(req: IncomingMessage, surface) {
    await Promise.resolve(); // genuinely async, modelling a remote member lookup
    if (surface === "internal") {
      return {
        ok: true,
        principal: { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] },
      };
    }
    const bearer = req.headers.authorization ?? "";
    if (bearer === MEMBER_BEARER) return { ok: true, principal: sarah };
    if (bearer === INTRUDER_BEARER) return { ok: true, principal: bob };
    return { ok: false, status: 401 };
  },
};

// The VaultRouter (062 seam): Sarah recalls/searches/grooms across [personal, team] and writes to
// personal; Bob is deliberately MIS-ROUTED — his `writeTarget` is the read-only team shelf, so his
// `remember` must fail with the typed ShelfNotWritableError (SC 6).
const teamsRouter: VaultRouter = {
  shelves(principal: Principal, op): readonly Shelf[] {
    if (op === "write") return principal.actorId === bob.actorId ? [team] : [personal];
    return [personal, team];
  },
  writeTarget(principal: Principal): Shelf {
    return principal.actorId === bob.actorId ? team : personal;
  },
};

// ONE plugin filling BOTH provider seams — the composition SC 9 exercises.
const teamsPlugin: LibrarianPlugin = {
  name: "teams-overlay",
  authProvider: memberAuth,
  vaultRouter: teamsRouter,
};

// Base options: every scheduler timer OFF, ephemeral loopback binds (mirrors the 060/061 e2e).
function baseOptions(dataDir: string): LibrarianServerOptions {
  return {
    dataDir,
    secretKey: null,
    host: "127.0.0.1",
    port: 0,
    trpcHost: "127.0.0.1",
    trpcPort: 0,
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    maxBodyBytes: 1024 * 1024,
    backupTickMs: 0,
    intakePollMs: 0,
    groomingPollMs: 0,
    transcriptSweepTickMs: 0,
  };
}

// Wait until an http.Server has bound (a `port: 0` bind is asynchronous) and return its port.
function listeningPort(server: import("node:http").Server): Promise<number> {
  const portOf = (): number => (server.address() as AddressInfo).port;
  if (server.listening) return Promise.resolve(portOf());
  return new Promise((resolve) => server.once("listening", () => resolve(portOf())));
}

interface JsonRpcResponse {
  result?: { content?: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

// POST a single MCP tools/call to the public /mcp and return the parsed JSON-RPC response.
async function mcpCall(
  base: string,
  bearer: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: JsonRpcResponse }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: bearer },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  return { status: res.status, body: (await res.json()) as JsonRpcResponse };
}

// The text of a successful tool result (the recall formatter output).
function toolText(body: JsonRpcResponse): string {
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== "string")
    throw new Error(`no tool text in response: ${JSON.stringify(body)}`);
  return text;
}

// The .md files under a shelf's memories dir.
function memoryFiles(dataDir: string, prefix: string): string[] {
  const dir = path.join(dataDir, "vault", prefix, "memories");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
}

// The `agent_id` from a memory file's frontmatter.
function agentIdOf(dataDir: string, prefix: string, file: string): string {
  const raw = fs.readFileSync(path.join(dataDir, "vault", prefix, "memories", file), "utf8");
  const match = raw.match(/^agent_id:\s*(.+)$/m);
  if (!match) throw new Error(`no agent_id in frontmatter:\n${raw}`);
  return match[1]!.trim().replace(/^['"]|['"]$/g, "");
}

async function startServer(dataDir: string): Promise<{
  server: ReturnType<typeof createLibrarianServer>;
  publicBase: string;
}> {
  const server = createLibrarianServer({ ...baseOptions(dataDir), plugins: [teamsPlugin] });
  server.start();
  const publicPort = await listeningPort(server.internals.publicServer);
  return { server, publicBase: `http://127.0.0.1:${publicPort}` };
}

describe("spec 062 SC 9 — the Teams shape works end to end (member auth + vault router over HTTP)", () => {
  it("lands the member write on their shelf, merges labelled recall from both shelves, refuses a read-only write, and survives a backup/restore round-trip", async () => {
    const dataDir = makeTempDir();
    const remoteDir = makeTempDir();
    const bareRemote = path.join(remoteDir, "vault.git");
    execFileSync("git", ["init", "--bare", bareRemote], { stdio: "ignore" });

    let stopped = true;
    let { server, publicBase } = await startServer(dataDir);
    stopped = false;
    try {
      // ── Seed the team shelf (read-only in the router) via a WRITABLE scoped handle, so the
      // member's recall has a team-side hit to merge. The handle is keyed by prefix, so the
      // router's read-only team shelf later reuses it for reads (writes never flow through recall).
      const teamSeedShelf: Shelf = {
        id: "team",
        prefix: "team/",
        writable: true,
        label: "Team library",
      };
      server.store.forShelf(teamSeedShelf).createMemory(
        {
          agent_id: "team-librarian",
          title: "Team pineapple runbook",
          body: "the team pineapple deployment runbook",
        },
        {},
      );

      // ── (1) The member's MCP `remember` lands under members/x/memories/…, actor = member-sarah.
      const remember = await mcpCall(publicBase, MEMBER_BEARER, "remember", {
        title: "Sarah pineapple note",
        body: "sarah pineapple planning note",
        category: "tools",
        visibility: "common",
        scope: "global",
      });
      expect(remember.status).toBe(200);
      expect(remember.body.error).toBeUndefined();

      const memberFiles = memoryFiles(dataDir, "members/x");
      expect(memberFiles).toHaveLength(1);
      expect(agentIdOf(dataDir, "members/x", memberFiles[0]!)).toBe("member-sarah");
      // Nothing landed at the vault root — this is a purely shelf-prefixed vault.
      expect(memoryFiles(dataDir, "")).toHaveLength(0);

      // ── (2) The member's MCP `recall` returns LABELLED hits from BOTH shelves, interleaved.
      const recall = await mcpCall(publicBase, MEMBER_BEARER, "recall", { query: "pineapple" });
      expect(recall.status).toBe(200);
      const text = toolText(recall.body);
      const personalToken = "[Sarah's shelf (members/x)]";
      const teamToken = "[Team library (team)]";
      expect(text).toContain(personalToken);
      expect(text).toContain(teamToken);
      // Router-order priority: the personal (higher-precedence) shelf's hit interleaves first.
      expect(text.indexOf(personalToken)).toBeLessThan(text.indexOf(teamToken));

      // ── (3) A write routed to the READ-ONLY team shelf surfaces a CLEAN JSON-RPC error (SC 6).
      const teamFilesBefore = memoryFiles(dataDir, "team");
      const refused = await mcpCall(publicBase, INTRUDER_BEARER, "remember", {
        title: "Bob team note",
        body: "bob attempts a write onto the read-only team shelf",
        category: "tools",
        visibility: "common",
        scope: "global",
      });
      // The /mcp transport still answers 200 — the typed error is folded into the JSON-RPC
      // envelope (code -32000), NOT a 500 crash.
      expect(refused.status).toBe(200);
      expect(refused.body.result).toBeUndefined();
      expect(refused.body.error?.code).toBe(-32000);
      expect(refused.body.error?.message).toMatch(/read-only/);
      // The refused write left the team shelf untouched.
      expect(memoryFiles(dataDir, "team")).toEqual(teamFilesBefore);

      // ── (4) Backup + restore round-trip on the SHELVED vault.
      // Backup: a real `git push` of the vault to the local bare remote.
      const commit = server.store.pushVaultBackup({
        remoteUrl: bareRemote,
        branch: "main",
        token: "unused",
      });
      expect(typeof commit).toBe("string");

      // Restore, phase 1 (live): clone the backup into the restore-staging dir — the SAME
      // `cloneVaultBackup` the live stager uses. The clone is the shelf-prefixed tree.
      const stagingDir = path.join(dataDir, ".restore-staging");
      cloneVaultBackup({
        remoteUrl: bareRemote,
        branch: "main",
        token: "unused",
        dest: stagingDir,
      });
      fs.writeFileSync(
        path.join(dataDir, RESTORE_MARKER),
        JSON.stringify({ repo: "local/backup", staged_at: new Date().toISOString() }),
      );

      // Stop the live server so the vault working tree can be swapped (as a restart would).
      await server.stop();
      stopped = true;

      // Restore, phase 2 (boot): the REAL applyPendingRestore. Its `isLibrarianVault` check must
      // now ACCEPT the shelf-prefixed clone (the T7 generalisation) — the load-bearing assertion:
      // pre-T7 the root-only check rejected this tree and this would be `applied: false`.
      const applied = applyPendingRestore(dataDir);
      expect(applied).toEqual({ applied: true, repo: "local/backup" });

      // BOTH shelves' files survived the swap (file-level).
      expect(memoryFiles(dataDir, "members/x")).toHaveLength(1);
      expect(memoryFiles(dataDir, "team")).toHaveLength(1);

      // Reopen the server on the restored vault; a post-restore recall still returns both shelves'
      // labelled hits (per-shelf indexes rebuilt from the restored disk).
      ({ server, publicBase } = await startServer(dataDir));
      stopped = false;
      const postRestore = await mcpCall(publicBase, MEMBER_BEARER, "recall", {
        query: "pineapple",
      });
      expect(postRestore.status).toBe(200);
      const postText = toolText(postRestore.body);
      expect(postText).toContain("[Sarah's shelf (members/x)]");
      expect(postText).toContain("[Team library (team)]");

      await server.stop();
      stopped = true;
    } finally {
      if (!stopped) {
        try {
          await server.stop();
        } catch {
          /* best-effort teardown */
        }
      }
      cleanupTempDir(dataDir);
      cleanupTempDir(remoteDir);
    }
  }, 60_000);
});
