// spec 065 T4 — the scoped slice at the PROCEDURE level (SC 7, SC 8).
//
// Five procedures use `memberProcedure` WITH principal-scoped store surfaces:
// `memories.list`, `memories.distinctValues`, `memories.recall`, `vault.searchReferences`,
// `vault.shelves`.
// Driven through the real appRouter via createCallerFactory (precedent:
// tests/trpc/principal.test.ts) against a store built with a two-shelf fixture router:
//   - a member sees ONLY their shelf contents, shelf-attributed per 062's rule;
//   - recall and searchReferences hits carry 062's provenance labels;
//   - an anonymous (role-less) caller gets UNAUTHORIZED from all four;
//   - admin + DEFAULT router: list is byte-identical to the legacy vault-global listMemories.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Principal, Shelf, VaultRouter } from "@librarian/core";
import { createLibrarianStore } from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);

const ALICE_SHELF: Shelf = {
  id: "alice",
  prefix: "members/alice/",
  writable: true,
  label: "Alice's shelf",
};
const TEAM_SHELF: Shelf = { id: "team", prefix: "team/", writable: false };
const BOB_SHELF: Shelf = { id: "bob", prefix: "members/bob/", writable: true };

// alice sees [her shelf, team]; bob's shelf is OUTSIDE her set.
const fixtureRouter: VaultRouter = {
  shelves: (principal) =>
    principal.attrs?.memberId === "alice" ? [ALICE_SHELF, TEAM_SHELF] : [BOB_SHELF],
  writeTarget: (principal) => (principal.attrs?.memberId === "alice" ? ALICE_SHELF : BOB_SHELF),
};

const alice: Principal = {
  kind: "member",
  actorId: "member:alice",
  roles: ["member"],
  attrs: { memberId: "alice" },
};
const anonymous: Principal = { kind: "agent", actorId: "anonymous", roles: [] };
const admin: Principal = { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] };

const dataDirs: string[] = [];
const stores: ReturnType<typeof createLibrarianStore>[] = [];
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

function freshStore(router?: VaultRouter): {
  store: ReturnType<typeof createLibrarianStore>;
  dataDir: string;
} {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-scoped-slice-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, ...(router ? { vaultRouter: router } : {}) });
  stores.push(store);
  return { store, dataDir };
}

function contextFor(principal: Principal, store: TrpcContext["store"]): TrpcContext {
  return {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "anonymous",
    store,
    secretKey: null,
    adminToken: "",
  };
}

function writeReference(dataDir: string, shelf: Shelf, name: string, body: string): void {
  const dir = path.join(dataDir, "vault", ...shelf.prefix.split("/").filter(Boolean), "references");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `# ${name}\n\n${body}\n`);
}

describe("spec 065 SC 7 — the four slice procedures, member + fixture router", () => {
  it("memories.list: only alice's shelves are visible, rows shelf-attributed; bob's memory invisible", async () => {
    const { store } = freshStore(fixtureRouter);
    store.forShelf(ALICE_SHELF).createMemory({ title: "alice note", body: "a", agent_id: "x" }, {});
    // The team shelf is read-only for principals; seed it through the raw system path.
    store
      .groomingStoreForShelf(TEAM_SHELF)
      .createMemory({ title: "team note", body: "t", agent_id: "x" }, {});
    store.forShelf(BOB_SHELF).createMemory({ title: "bob secret", body: "b", agent_id: "x" }, {});

    const caller = createCaller(contextFor(alice, store));
    const page = await caller.memories.list({ sort: "title", order: "asc" });

    expect(page.memories.map((m) => m.title)).toEqual(["alice note", "team note"]);
    expect(page.total).toBe(2);
    const rows = page.memories as Array<{ title: string; shelfId?: string; shelfLabel?: string }>;
    expect(rows[0]?.shelfId).toBe("alice");
    expect(rows[0]?.shelfLabel).toBe("Alice's shelf");
    expect(rows[1]?.shelfId).toBe("team");
    expect(rows[1]?.shelfLabel).toBeUndefined();
  });

  it("memories.distinctValues: the union over alice's shelves — bob's agent ids never appear", async () => {
    const { store } = freshStore(fixtureRouter);
    store.forShelf(ALICE_SHELF).createMemory({ title: "n1", body: "a", agent_id: "agent-a" }, {});
    store
      .groomingStoreForShelf(TEAM_SHELF)
      .createMemory({ title: "n2", body: "t", agent_id: "agent-t" }, {});
    store.forShelf(BOB_SHELF).createMemory({ title: "n3", body: "b", agent_id: "agent-bob" }, {});

    const caller = createCaller(contextFor(alice, store));
    const values = await caller.memories.distinctValues({ field: "agent_id" });

    expect(values).toEqual(["agent-a", "agent-t"]);
  });

  it("memories.recall: merged hits carry 062's provenance labels; bob's memory never surfaces", async () => {
    const { store } = freshStore(fixtureRouter);
    store
      .forShelf(ALICE_SHELF)
      .createMemory({ title: "A note", body: "piano tuning", agent_id: "x" }, {});
    store
      .groomingStoreForShelf(TEAM_SHELF)
      .createMemory({ title: "T note", body: "piano roster", agent_id: "x" }, {});
    store
      .forShelf(BOB_SHELF)
      .createMemory({ title: "B note", body: "piano secret", agent_id: "x" }, {});

    const caller = createCaller(contextFor(alice, store));
    const { memories } = await caller.memories.recall({ query: "piano" });
    const rows = memories as Array<{ title: string; shelfId?: string; shelfLabel?: string }>;

    expect(rows.map((m) => m.title).sort()).toEqual(["A note", "T note"]);
    expect(rows.find((m) => m.title === "A note")?.shelfId).toBe("alice");
    expect(rows.find((m) => m.title === "A note")?.shelfLabel).toBe("Alice's shelf");
    expect(rows.find((m) => m.title === "T note")?.shelfId).toBe("team");
  });

  it("vault.searchReferences: merged hits labelled; `searched` is the SCOPED denominator", async () => {
    const { store, dataDir } = freshStore(fixtureRouter);
    writeReference(dataDir, ALICE_SHELF, "alice-ref", "harpsichord maintenance");
    writeReference(dataDir, TEAM_SHELF, "team-ref", "harpsichord booking");
    writeReference(dataDir, BOB_SHELF, "bob-ref", "harpsichord secret");

    const caller = createCaller(contextFor(alice, store));
    const result = await caller.vault.searchReferences({ query: "harpsichord" });
    const hits = result.references as Array<{ id: string; shelfId?: string; shelfLabel?: string }>;

    // Only alice's two shelves are searched — bob's reference is invisible AND uncounted.
    expect(result.searched).toBe(2);
    expect(hits.map((h) => h.shelfId).sort()).toEqual(["alice", "team"]);
    expect(hits.find((h) => h.shelfId === "alice")?.shelfLabel).toBe("Alice's shelf");
    expect(hits.some((h) => h.id.includes("bob"))).toBe(false);
  });

  it("an anonymous (role-less) caller gets UNAUTHORIZED from all four slice procedures", async () => {
    const { store } = freshStore(fixtureRouter);
    const caller = createCaller(contextFor(anonymous, store));

    await expect(caller.memories.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.memories.distinctValues({ field: "agent_id" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.memories.recall({ query: "x" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.vault.searchReferences({ query: "x" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("admin + DEFAULT router: memories.list is byte-identical to the legacy vault-global list (SC 4)", async () => {
    const { store } = freshStore();
    store.createMemory({ title: "one", body: "b", agent_id: "x" }, {});
    store.createMemory({ title: "two", body: "b", agent_id: "x" }, {});

    const caller = createCaller(contextFor(admin, store));
    const viaProcedure = await caller.memories.list();
    const legacy = store.listMemories();

    expect(viaProcedure).toEqual(legacy);
    for (const row of viaProcedure.memories) {
      expect(row).not.toHaveProperty("shelfId");
      expect(row).not.toHaveProperty("shelfLabel");
    }
  });
});

describe("spec 066 — shelf enumeration and list restriction", () => {
  it("vault.shelves withholds prefixes and exposes the member's deduped recall set", async () => {
    const { store } = freshStore(fixtureRouter);
    const caller = createCaller(contextFor(alice, store));

    await expect(caller.vault.shelves()).resolves.toEqual([
      { id: "alice", label: "Alice's shelf", writable: true },
      { id: "team", writable: false },
    ]);
  });

  it("vault.shelves merges shared ids with first-label precedence and writable OR", async () => {
    const readOnly: Shelf = {
      id: "shared",
      prefix: "shared-read/",
      writable: false,
      label: "First label",
    };
    const writable: Shelf = {
      id: "shared",
      prefix: "shared-write/",
      writable: true,
      label: "Later label",
    };
    const router: VaultRouter = {
      shelves: () => [readOnly, writable],
      writeTarget: () => writable,
    };
    const { store } = freshStore(router);
    const caller = createCaller(contextFor(alice, store));

    await expect(caller.vault.shelves()).resolves.toEqual([
      { id: "shared", label: "First label", writable: true },
    ]);
  });

  it("vault.shelves admits members and admins, rejects anonymous callers, and is inert by default", async () => {
    const fixture = freshStore(fixtureRouter).store;
    const memberCaller = createCaller(contextFor(alice, fixture));
    const adminCaller = createCaller(contextFor(admin, fixture));
    const anonymousCaller = createCaller(contextFor(anonymous, fixture));

    await expect(memberCaller.vault.shelves()).resolves.toHaveLength(2);
    await expect(adminCaller.vault.shelves()).resolves.toEqual([{ id: "bob", writable: true }]);
    await expect(anonymousCaller.vault.shelves()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const defaultStore = freshStore().store;
    const defaultCaller = createCaller(contextFor(admin, defaultStore));
    await expect(defaultCaller.vault.shelves()).resolves.toEqual([{ id: "main", writable: true }]);
  });

  it("memories.list filters by shelf id and returns plain rows when one shelf remains", async () => {
    const { store } = freshStore(fixtureRouter);
    store.forShelf(ALICE_SHELF).createMemory({ title: "alice note", body: "a", agent_id: "x" }, {});
    store
      .groomingStoreForShelf(TEAM_SHELF)
      .createMemory({ title: "team note", body: "t", agent_id: "x" }, {});
    const caller = createCaller(contextFor(alice, store));

    const page = await caller.memories.list({ shelf: "team" });

    expect(page.memories.map((memory) => memory.title)).toEqual(["team note"]);
    expect(page.memories[0]?.shelfId).toBeUndefined();
    expect(page.memories[0]?.shelfLabel).toBeUndefined();
  });

  it("memories.list gives the same empty envelope for off-set and unknown shelf ids", async () => {
    const { store } = freshStore(fixtureRouter);
    store.forShelf(BOB_SHELF).createMemory({ title: "bob secret", body: "b", agent_id: "x" }, {});
    const caller = createCaller(contextFor(alice, store));

    const offSet = await caller.memories.list({ shelf: "bob" });
    const absent = await caller.memories.list({ shelf: "never-existed" });

    expect(offSet).toEqual(absent);
    expect(offSet).toEqual({ memories: [], total: 0, limit: 100, offset: 0 });
  });
});
