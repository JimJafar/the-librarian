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
  type Principal,
  type Shelf,
  type VaultRouter,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const A: Shelf = { id: "a", prefix: "members/a/", writable: true };
const B: Shelf = { id: "b", prefix: "members/b/", writable: true };

const PRINCIPAL: Principal = { kind: "agent", actorId: "a", roles: ["agent"] };

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

/** Every persistent embedding-cache record's stored `path` (the full vault-relative cache key). */
function cacheRecordPaths(dataDir: string): string[] {
  const base = path.join(dataDir, "embeddings-cache");
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  for (const modelDir of fs.readdirSync(base)) {
    const dir = path.join(base, modelDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { path?: string };
        if (rec.path) out.push(rec.path);
      } catch {
        /* ignore torn records */
      }
    }
  }
  return out;
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

  it("recallForPrincipal (the MCP recall path) does ONE shelf iteration + at most one build", async () => {
    // The merged-recall entrypoint (spec 062 T5) must reduce to today's single-shelf recall under
    // the default router: one shelf, so one build, and a repeat is a cache hit — the same SC 10 pin
    // as `store.recall`, through the NEW principal-aware path the MCP recall tool now calls.
    const builds: string[] = [];
    const store = freshStore(builds);
    store.createMemory({ title: "Piano tuning", body: "tune the grand piano", agent_id: "a" }, {});

    await store.recallForPrincipal(PRINCIPAL, { query: "piano" });
    await store.recallForPrincipal(PRINCIPAL, { query: "piano" });

    // ONE build for the single default shelf (prefix "") — the second recall is a cache hit.
    expect(builds).toEqual([""]);
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

  it("memoizes the CORE by prefix: two views over one prefix SHARE the cached index; distinct prefixes don't (spec 062 T4 + review A2)", async () => {
    // forShelf now returns a per-call gate VIEW (review A2), so referential identity is no longer
    // guaranteed — but the expensive CORE (scoped vault + cached index) is memoized ONE-per-prefix.
    // Prove it behaviourally: a recall through a SECOND, independently-obtained view of the SAME
    // prefix hits the cache the FIRST view's recall built (one build, not two); a distinct prefix is
    // a distinct core with its own build.
    const builds: string[] = [];
    const store = freshStore(builds, twoWritableRouter);
    store
      .forShelf(A)
      .createMemory({ title: "Piano", body: "tune the grand piano", agent_id: "x" }, {});

    await store.forShelf(A).recall({ query: "piano" }); // build A
    // Same prefix, different id/label object → the SAME memoized core → a cache hit, no rebuild.
    await store
      .forShelf({ id: "a-renamed", prefix: "members/a/", writable: true, label: "Renamed" })
      .recall({ query: "piano" });
    expect(builds).toEqual(["members/a/"]);

    // A distinct prefix is a distinct core → its own build.
    store
      .forShelf(B)
      .createMemory({ title: "Sailing", body: "navigate open water", agent_id: "x" }, {});
    await store.forShelf(B).recall({ query: "sailing" });
    expect(builds).toEqual(["members/a/", "members/b/"]);
  });

  it("the embedding cache keys on the FULL vault-relative path: two shelves' same-relative-path records coexist and survive each other's prune (spec 062 T4 / review G4)", async () => {
    // Two shelves each hold a reference at the SAME shelf-relative path (`references/shared.md`) but
    // DISTINCT content. The persistent embedding cache keys on the FULL vault-relative path
    // (cacheKeyPrefix = shelf.prefix), so the two land as SEPARATE records and neither shelf's
    // build/prune touches the other. Reverting to shelf-relative keys would collide them into one
    // record (no `members/a/…` / `members/b/…` paths) and cross-prune — this test would then fail.
    const store = freshStore([], twoWritableRouter);
    store
      .forShelf(A)
      .vaultFiles.createFile(
        "members/a/references/shared.md",
        "# Alpha\n\nthe alpha reference is about piano tuning",
      );
    store
      .forShelf(B)
      .vaultFiles.createFile(
        "members/b/references/shared.md",
        "# Beta\n\nthe beta reference is about piano restringing",
      );

    await store.forShelf(A).searchReferences("piano"); // build + cache + prune A's references
    await store.forShelf(B).searchReferences("piano"); // build + cache + prune B's references

    const afterBoth = cacheRecordPaths(store.dataDir);
    expect(afterBoth).toContain("members/a/references/shared.md");
    expect(afterBoth).toContain("members/b/references/shared.md");

    // Rebuild A's references (a fresh search re-runs A's build + prune). B's record — a DISTINCT
    // full-path key — survives A's prune.
    await store.forShelf(A).searchReferences("piano");
    expect(cacheRecordPaths(store.dataDir)).toContain("members/b/references/shared.md");
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
