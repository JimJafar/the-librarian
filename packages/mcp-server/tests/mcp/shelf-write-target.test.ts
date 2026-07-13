// Write-target enforcement at the MCP boundary (spec 062 T3 / SC 6). A `remember` routed through
// a two-shelf router lands the memory under the principal's `writeTarget` shelf — asserted from the
// WRITTEN FILE — and a router whose `writeTarget` is a read-only shelf surfaces the typed
// ShelfNotWritableError as a clean JSON-RPC error, not a crash. With the default router this is
// byte-identical (proven by the existing remember suites).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type Shelf,
  type VaultRouter,
  createLibrarianStore,
} from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";

const MEMBERS_X: Shelf = { id: "members-x", prefix: "members/x/", writable: true };
const TEAM: Shelf = { id: "team", prefix: "team/", writable: false };

const sarah: Principal = {
  kind: "agent",
  actorId: "sarah",
  boundActorId: "sarah",
  roles: ["agent"],
};

interface CallResponse {
  result?: { content: { text: string }[] };
  error?: { message: string };
}

const dataDirs: string[] = [];
const stores: LibrarianStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(router: VaultRouter): { store: LibrarianStore; vault: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-wt-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, vaultRouter: router });
  stores.push(store);
  return { store, vault: path.join(dataDir, "vault") };
}

function remember(store: LibrarianStore, args: Record<string, unknown>): Promise<CallResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: args } },
    { principal: sarah },
  ) as unknown as Promise<CallResponse>;
}

describe("remember — write-target routing (spec 062 SC 6, MCP half)", () => {
  it("lands the memory under the principal's writeTarget shelf (members/x/memories/…)", async () => {
    const router: VaultRouter = {
      shelves: (_p, op) => (op === "write" ? [MEMBERS_X] : [MEMBERS_X, TEAM]),
      writeTarget: () => MEMBERS_X,
    };
    const { store, vault } = freshStore(router);

    const res = await remember(store, {
      title: "Deploy runbook",
      body: "Roll back with plat rollback.",
      agent_id: "sarah",
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.content[0]?.text).toMatch(/Memory saved/);

    // Asserted from the file: the memory lands under the writeTarget shelf, not the vault root.
    const shelfMemDir = path.join(vault, "members/x/memories");
    const files = fs.readdirSync(shelfMemDir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(shelfMemDir, files[0]!), "utf8")).toMatch(
      /^agent_id: sarah$/m,
    );
    expect(fs.existsSync(path.join(vault, "memories"))).toBe(false); // nothing at the root shelf
  });

  it("a non-writable writeTarget surfaces the typed error as a clean JSON-RPC error (no crash)", async () => {
    const router: VaultRouter = {
      shelves: () => [MEMBERS_X, TEAM],
      writeTarget: () => TEAM, // read-only
    };
    const { store, vault } = freshStore(router);

    const res = await remember(store, {
      title: "Nope",
      body: "read-only shelf",
      agent_id: "sarah",
    });
    // A clean JSON-RPC error (the -32000 boundary), not a thrown 500.
    expect(res.result).toBeUndefined();
    expect(res.error?.message).toMatch(/read-only/i);
    // Nothing was written to either shelf.
    expect(fs.existsSync(path.join(vault, "team/memories"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "members/x/memories"))).toBe(false);
  });
});
