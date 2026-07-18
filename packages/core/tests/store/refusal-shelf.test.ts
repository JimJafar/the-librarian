import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type Shelf,
  type VaultRouter,
  ShelfNotInWriteSetError,
  ShelfNotWritableError,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const PRINCIPAL: Principal = {
  kind: "member",
  actorId: "member:alice",
  roles: ["member"],
  tokenId: "tok-member",
};
const PERSONAL: Shelf = {
  id: "personal",
  prefix: "members/alice/",
  writable: true,
};
const TEAM: Shelf = {
  id: "team",
  prefix: "team/",
  writable: false,
};
const OUTSIDE: Shelf = {
  id: "outside",
  prefix: "members/bob/",
  writable: true,
};

const stores: LibrarianStore[] = [];
const dataDirs: string[] = [];

function makeStore(vaultRouter?: VaultRouter): LibrarianStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-refusal-shelf-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({
    dataDir,
    refusalLog: { armed: true },
    ...(vaultRouter ? { vaultRouter } : {}),
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dataDir of dataDirs.splice(0)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("shelf-routing refusal evidence", () => {
  it("records read-only shelf refusals only when a multi-shelf router makes them reachable", async () => {
    const router: VaultRouter = {
      shelves: () => [PERSONAL, TEAM],
      writeTarget: () => TEAM,
    };
    const store = makeStore(router);

    expect(() => store.resolveWriteTarget(PRINCIPAL)).toThrow(ShelfNotWritableError);
    expect(() =>
      store.forShelf(TEAM).createMemory({ title: "refused", body: "not written" }, {}),
    ).toThrow(ShelfNotWritableError);

    const created = store.forShelf(PERSONAL).createMemory({ title: "source", body: "move me" }, {});
    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, created.memory.id, TEAM.id)).toThrow(
      ShelfNotWritableError,
    );

    const evidence = await store.readRefusals({ kind: "shelf-not-writable" });
    expect(evidence.rows).toHaveLength(3);
    expect(evidence.rows).toContainEqual(
      expect.objectContaining({
        actorId: "member:alice",
        roles: ["member"],
        tokenId: "tok-member",
      }),
    );
  });

  it("records a writable target outside the principal's multi-shelf write set", async () => {
    const router: VaultRouter = {
      shelves: () => [PERSONAL, TEAM],
      writeTarget: () => OUTSIDE,
    };
    const store = makeStore(router);

    expect(() => store.resolveWriteTarget(PRINCIPAL)).toThrow(ShelfNotInWriteSetError);

    expect((await store.readRefusals()).rows).toEqual([
      expect.objectContaining({
        kind: "shelf-outside-write-set",
        surface: "store",
        outcome: "refused",
        actorId: "member:alice",
        roles: ["member"],
        tokenId: "tok-member",
      }),
    ]);
  });

  it("records nothing for ordinary writes through the default single-shelf router", async () => {
    const store = makeStore();

    const target = store.resolveWriteTarget(PRINCIPAL);
    store.forShelf(target).createMemory({ title: "allowed", body: "written" }, {});

    expect(await store.readRefusals()).toEqual({ rows: [], total: 0, dropped: 0 });
    expect(fs.existsSync(path.join(store.dataDir, "refusal-log.ndjson"))).toBe(false);
  });
});
