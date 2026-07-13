// Per-shelf corpus index: caching + scoped invalidation (spec 062 T4 — SC 4 + SC 10). Proves the
// recall index is built-and-cached PER SHELF and invalidated per shelf:
//   - SC 10 (default router, no hot-path regression): recall builds AT MOST one index and does
//     exactly one shelf iteration — a second recall hits the cache (no rebuild), a write forces
//     exactly one rebuild, and a filter-only (no-query) recall builds nothing.
//   - SC 4 (two-shelf invalidation): a write to shelf A rebuilds ONLY A; shelf B's cached index
//     survives untouched.
// Both are asserted through the injected build-counter seam (`LibrarianStoreOptions.onIndexBuild`,
// a non-API measurement hook that fires with the shelf prefix on each REAL index build).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Shelf,
  type VaultRouter,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const A: Shelf = { id: "a", prefix: "members/a/", writable: true };
const B: Shelf = { id: "b", prefix: "members/b/", writable: true };

const twoWritableRouter: VaultRouter = {
  shelves: () => [A, B],
  writeTarget: () => A,
};

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

/** A fresh store whose real index (re)builds append their shelf prefix to `builds`. */
function freshStore(builds: string[], router?: VaultRouter): LibrarianStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-shelf-index-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({
    dataDir,
    onIndexBuild: (shelfPrefix) => builds.push(shelfPrefix),
    ...(router ? { vaultRouter: router } : {}),
  });
  stores.push(store);
  return store;
}

describe("per-shelf index caching under the DEFAULT router (spec 062 SC 10)", () => {
  it("recall builds at most one index; a repeat recall hits the cache (no rebuild)", async () => {
    const builds: string[] = [];
    const store = freshStore(builds);
    store.createMemory({ title: "Piano tuning", body: "tune the grand piano", agent_id: "a" }, {});

    await store.recall({ query: "piano" });
    await store.recall({ query: "piano" });

    // Exactly ONE build, for the single default shelf (prefix "") — the second recall is a cache hit.
    expect(builds).toEqual([""]);
  });

  it("a memory write invalidates the cache; the next recall rebuilds exactly once", async () => {
    const builds: string[] = [];
    const store = freshStore(builds);
    store.createMemory({ title: "Piano tuning", body: "tune the grand piano", agent_id: "a" }, {});

    await store.recall({ query: "piano" }); // build #1
    store.createMemory({ title: "Sailing", body: "navigate open water", agent_id: "a" }, {}); // invalidates
    await store.recall({ query: "sailing" }); // build #2
    await store.recall({ query: "sailing" }); // cache hit

    expect(builds).toEqual(["", ""]);
  });

  it("a filter-only (no-query) recall builds no index — it stays on keyword searchMemories", async () => {
    const builds: string[] = [];
    const store = freshStore(builds);
    store.createMemory({ title: "Piano", body: "tune it", agent_id: "a", tags: ["music"] }, {});

    await store.recall({ tags: ["music"] }); // no query → no index build
    await store.recall({}); // no query → no index build

    expect(builds).toEqual([]);
  });

  it("reindex drops the cache so the next recall rebuilds", async () => {
    const builds: string[] = [];
    const store = freshStore(builds);
    store.createMemory({ title: "Piano", body: "tune it", agent_id: "a" }, {});

    await store.recall({ query: "piano" }); // build #1
    store.reindex(); // vault-wide invalidation
    await store.recall({ query: "piano" }); // build #2

    expect(builds).toEqual(["", ""]);
  });
});

describe("per-shelf index caching under a TWO-shelf router (spec 062 SC 4)", () => {
  it("a write to shelf A rebuilds only A; shelf B's cached index survives", async () => {
    const builds: string[] = [];
    const store = freshStore(builds, twoWritableRouter);
    const a = store.forShelf(A);
    const b = store.forShelf(B);

    a.createMemory({ title: "Piano tuning", body: "tune the grand piano", agent_id: "x" }, {});
    b.createMemory({ title: "Sailing", body: "navigate open water", agent_id: "x" }, {});

    await a.recall({ query: "piano" }); // build A
    await b.recall({ query: "sailing" }); // build B
    expect(builds).toEqual(["members/a/", "members/b/"]);

    // A write to A invalidates ONLY A.
    a.createMemory({ title: "Guitar", body: "restring the guitar", agent_id: "x" }, {});
    await a.recall({ query: "guitar" }); // rebuild A
    await b.recall({ query: "sailing" }); // B is a cache hit — no rebuild

    // The third build is A's prefix; B never rebuilt (its cache survived A's write).
    expect(builds).toEqual(["members/a/", "members/b/", "members/a/"]);
  });

  it("forShelf memoizes by prefix: the same shelf returns one handle, distinct shelves differ", () => {
    const builds: string[] = [];
    const store = freshStore(builds, twoWritableRouter);

    expect(store.forShelf(A)).toBe(store.forShelf(A));
    // Same prefix, different id/label object → the SAME handle (prefix is the key).
    expect(store.forShelf(A)).toBe(
      store.forShelf({ id: "a-renamed", prefix: "members/a/", writable: true, label: "Renamed" }),
    );
    expect(store.forShelf(A)).not.toBe(store.forShelf(B));
  });

  it("a read-only shelf still builds and caches its recall index (reads are allowed)", async () => {
    const readOnly: Shelf = { id: "team", prefix: "team/", writable: false };
    const router: VaultRouter = {
      shelves: (_p, op) => (op === "write" ? [A] : [A, readOnly]),
      writeTarget: () => A,
    };
    const builds: string[] = [];
    const store = freshStore(builds, router);
    const team = store.forShelf(readOnly);

    await team.recall({ query: "anything" }); // build (empty corpus is fine)
    await team.recall({ query: "anything" }); // cache hit

    expect(builds).toEqual(["team/"]);
  });
});
