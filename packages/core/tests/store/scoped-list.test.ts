// Principal-scoped memory list + the scoped read primitives (spec 065 SC 7, T4).
//
//   - listMemoriesForPrincipal: merged by the requested sort key with the deterministic
//     tie-break (router shelf order, then memory id), offset/limit AFTER the merge, total =
//     unique filtered ids after precedence dedupe, shelf attribution only when >1 shelf; DEFAULT
//     router → delegation to the main listMemories, byte-identical (the recallForPrincipal
//     reduction precedent).
//   - THE CLAMP REGRESSION: a merged page at offset+limit > 200 across two shelves returns the
//     correct rows — the public listMemories clamps at 200 and slices internally, so a merge
//     built on it would silently truncate (spec 065 §1/§4/§7 pass 1 finding 6).
//   - getMemoryForPrincipal: off-shelf id → null (no existence oracle).
//   - distinctValuesForPrincipal: union over the shelf set.
//   - countReferencesForPrincipal: Σ per-shelf reference counts ("search" op).
//   - THE EMPTY SET (062's rule): zero shelves → empty envelope / empty union / null, never a
//     throw.
//
// Style per tests/store/merged-recall.test.ts (062 T5).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Memory,
  type Principal,
  type Shelf,
  type VaultRouter,
  createLibrarianStore,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

// Shelf A (labelled, higher precedence) before shelf B (unlabelled) in router order.
const A: Shelf = { id: "personal", prefix: "members/x/", writable: true, label: "Sarah's shelf" };
const B: Shelf = { id: "team", prefix: "team/", writable: true };
const C: Shelf = { id: "other", prefix: "members/y/", writable: true };
const PRINCIPAL: Principal = { kind: "member", actorId: "member:x", roles: ["member"] };

const twoShelfRouter: VaultRouter = { shelves: () => [A, B], writeTarget: () => A };
const zeroShelfRouter: VaultRouter = { shelves: () => [], writeTarget: () => A };

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

function freshStore(router?: VaultRouter): { store: LibrarianStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-scoped-list-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, ...(router ? { vaultRouter: router } : {}) });
  stores.push(store);
  return { store, dataDir };
}

/** A full, valid Memory — only `id`/`title` (and any overrides) vary per test. */
function mem(id: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    agent_id: "x",
    status: "active",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    title: id,
    body: `body ${id}`,
    confidence: "high",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    is_global: false,
    requires_approval: false,
    ...extra,
  };
}

/**
 * Write a memory document DIRECTLY into a shelf's memories/ directory (bypassing createMemory's
 * per-write git commit — 240 committed writes would dominate the suite). `listMemories` reads the
 * working tree via vault.listMarkdown, so uncommitted fixtures enumerate exactly like real rows.
 */
function writeMemoryFile(dataDir: string, shelf: Shelf, memory: Memory): void {
  const dir = path.join(dataDir, "vault", ...shelf.prefix.split("/").filter(Boolean), "memories");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${memory.id}.md`), serializeMemoryDocument(memory));
}

describe("listMemoriesForPrincipal — merge rule + attribution (spec 065 SC 7)", () => {
  it("merges two shelves by the requested sort key, attributes rows, and counts unique ids", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    // Titles interleave across shelves so the merged title-asc order proves a real cross-shelf sort.
    writeMemoryFile(dataDir, A, mem("mem_a1", { title: "alpha" }));
    writeMemoryFile(dataDir, A, mem("mem_a2", { title: "gamma" }));
    writeMemoryFile(dataDir, B, mem("mem_b1", { title: "beta" }));
    writeMemoryFile(dataDir, B, mem("mem_b2", { title: "delta" }));

    const page = store.listMemoriesForPrincipal(PRINCIPAL, { sort: "title", order: "asc" });

    expect(page.total).toBe(4);
    expect(page.limit).toBe(100);
    expect(page.offset).toBe(0);
    expect(page.memories.map((m) => m.title)).toEqual(["alpha", "beta", "delta", "gamma"]);
    // 062's attribution rule, active because the materialised set has length > 1.
    const alpha = page.memories.find((m) => m.id === "mem_a1");
    expect(alpha?.shelfId).toBe("personal");
    expect(alpha?.shelfLabel).toBe("Sarah's shelf");
    const beta = page.memories.find((m) => m.id === "mem_b1");
    expect(beta?.shelfId).toBe("team");
    expect(beta?.shelfLabel).toBeUndefined();
  });

  it("breaks sort-key ties deterministically: router shelf order first, then memory id", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    // Every row shares the same title, so the ENTIRE order is the tie-break.
    writeMemoryFile(dataDir, B, mem("mem_b2", { title: "same" }));
    writeMemoryFile(dataDir, B, mem("mem_b1", { title: "same" }));
    writeMemoryFile(dataDir, A, mem("mem_a2", { title: "same" }));
    writeMemoryFile(dataDir, A, mem("mem_a1", { title: "same" }));

    const page = store.listMemoriesForPrincipal(PRINCIPAL, { sort: "title", order: "asc" });

    // Shelf A (router order 0) before B, ids ascending within a tie.
    expect(page.memories.map((m) => m.id)).toEqual(["mem_a1", "mem_a2", "mem_b1", "mem_b2"]);
  });

  it("deduplicates the same logical memory id by router precedence before paging", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    writeMemoryFile(
      dataDir,
      A,
      mem("mem_shared", { title: "Personal copy", body: "higher precedence" }),
    );
    writeMemoryFile(
      dataDir,
      B,
      mem("mem_shared", { title: "Team copy", body: "lower precedence" }),
    );
    writeMemoryFile(dataDir, B, mem("mem_unique", { title: "Unique" }));

    const page = store.listMemoriesForPrincipal(PRINCIPAL, {
      sort: "title",
      order: "asc",
      limit: 1,
      offset: 0,
    });

    expect(page.total).toBe(2);
    expect(page.memories).toHaveLength(1);
    expect(page.memories[0]).toMatchObject({
      id: "mem_shared",
      title: "Personal copy",
      body: "higher precedence",
      shelfId: "personal",
    });
  });

  it("defaults to updated_at desc (the store default) when no sort is requested", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    writeMemoryFile(dataDir, A, mem("mem_old", { updated_at: "2026-01-01T00:00:00.000Z" }));
    writeMemoryFile(dataDir, B, mem("mem_new", { updated_at: "2026-06-01T00:00:00.000Z" }));

    const page = store.listMemoriesForPrincipal(PRINCIPAL);

    expect(page.memories.map((m) => m.id)).toEqual(["mem_new", "mem_old"]);
  });

  it("applies filters per the existing semantics before the merge (status narrows both shelves)", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    writeMemoryFile(dataDir, A, mem("mem_active_a"));
    writeMemoryFile(dataDir, A, mem("mem_archived_a", { status: "archived" }));
    writeMemoryFile(dataDir, B, mem("mem_active_b"));

    const page = store.listMemoriesForPrincipal(PRINCIPAL, { status: "active" });

    expect(page.total).toBe(2);
    expect(page.memories.map((m) => m.id).sort()).toEqual(["mem_active_a", "mem_active_b"]);
  });

  it("THE CLAMP REGRESSION: a merged page at offset+limit > 200 returns the correct rows across two shelves", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    // Shelf A holds 230 rows — deeper than the public listMemories' 200-cap — and shelf B 10.
    // Title-asc puts every A row before every B row (a-… < b-…), so the page at offset 225
    // needs A's rows at per-shelf positions 226-230: unreachable through the capped public
    // surface, exactly the truncation this test pins against.
    for (let i = 1; i <= 230; i++) {
      const n = String(i).padStart(4, "0");
      writeMemoryFile(dataDir, A, mem(`mem_a${n}`, { title: `a-${n}` }));
    }
    for (let i = 1; i <= 10; i++) {
      const n = String(i).padStart(4, "0");
      writeMemoryFile(dataDir, B, mem(`mem_b${n}`, { title: `b-${n}` }));
    }

    const page = store.listMemoriesForPrincipal(PRINCIPAL, {
      sort: "title",
      order: "asc",
      offset: 225,
      limit: 10,
    });

    expect(page.total).toBe(240);
    expect(page.offset).toBe(225);
    expect(page.limit).toBe(10);
    // Rows 226-235 of the merged order: A's last five (0226-0230), then B's first five.
    expect(page.memories.map((m) => m.title)).toEqual([
      "a-0226",
      "a-0227",
      "a-0228",
      "a-0229",
      "a-0230",
      "b-0001",
      "b-0002",
      "b-0003",
      "b-0004",
      "b-0005",
    ]);
    // Cross-shelf attribution survives pagination.
    expect(page.memories[4]?.shelfId).toBe("personal");
    expect(page.memories[5]?.shelfId).toBe("team");
  });

  it("DEFAULT router: delegates to the main listMemories — byte-identical envelope, NO shelf fields", () => {
    const { store, dataDir } = freshStore();
    writeMemoryFile(dataDir, { id: "default", prefix: "", writable: true }, mem("mem_1"));
    writeMemoryFile(dataDir, { id: "default", prefix: "", writable: true }, mem("mem_2"));

    const scoped = store.listMemoriesForPrincipal(PRINCIPAL);
    const legacy = store.listMemories();

    expect(scoped).toEqual(legacy); // the whole envelope, not just the rows
    for (const row of scoped.memories) {
      expect(row).not.toHaveProperty("shelfId");
      expect(row).not.toHaveProperty("shelfLabel");
    }
  });

  it("restricts to one shelf before enumeration and delegates plain rows", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    writeMemoryFile(dataDir, A, mem("mem_personal"));
    writeMemoryFile(dataDir, B, mem("mem_team"));

    const page = store.listMemoriesForPrincipal(PRINCIPAL, { shelf: "team" });

    expect(page.total).toBe(1);
    expect(page.memories.map((memory) => memory.id)).toEqual(["mem_team"]);
    expect(page.memories[0]).not.toHaveProperty("shelfId");
    expect(page.memories[0]).not.toHaveProperty("shelfLabel");
  });

  it("returns the empty envelope for an unknown shelf id without revealing whether it exists elsewhere", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    writeMemoryFile(dataDir, A, mem("mem_personal"));
    writeMemoryFile(dataDir, C, mem("mem_off_set"));

    expect(store.listMemoriesForPrincipal(PRINCIPAL, { shelf: "other" })).toEqual({
      memories: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    expect(store.listMemoriesForPrincipal(PRINCIPAL, { shelf: "never-existed" })).toEqual({
      memories: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
  });

  it("restricts a shared id to every matching shelf and keeps honest attribution", () => {
    const sharedReadOnly: Shelf = {
      id: "shared",
      prefix: "shared-read/",
      writable: false,
      label: "Shared read",
    };
    const sharedWritable: Shelf = {
      id: "shared",
      prefix: "shared-write/",
      writable: true,
      label: "Shared write",
    };
    const router: VaultRouter = {
      shelves: () => [sharedReadOnly, sharedWritable, B],
      writeTarget: () => sharedWritable,
    };
    const { store, dataDir } = freshStore(router);
    writeMemoryFile(dataDir, sharedReadOnly, mem("mem_read"));
    writeMemoryFile(dataDir, sharedWritable, mem("mem_write"));
    writeMemoryFile(dataDir, B, mem("mem_team"));

    const page = store.listMemoriesForPrincipal(PRINCIPAL, { shelf: "shared" });

    expect(page.total).toBe(2);
    expect(page.memories.map((memory) => memory.id).sort()).toEqual(["mem_read", "mem_write"]);
    expect(page.memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mem_read", shelfId: "shared", shelfLabel: "Shared read" }),
        expect.objectContaining({
          id: "mem_write",
          shelfId: "shared",
          shelfLabel: "Shared write",
        }),
      ]),
    );
  });
});

describe("shelvesForPrincipal — validated recall-set enumeration (spec 066 SC 3)", () => {
  it("returns the materialised recall shelves in router order", () => {
    const { store } = freshStore(twoShelfRouter);

    expect(store.shelvesForPrincipal(PRINCIPAL)).toEqual([A, B]);
  });

  it("returns an empty array for a principal with no recall shelves", () => {
    const { store } = freshStore(zeroShelfRouter);

    expect(store.shelvesForPrincipal(PRINCIPAL)).toEqual([]);
  });
});

describe("getMemoryForPrincipal — off-shelf ids are invisible (spec 065 SC 7)", () => {
  it("resolves an on-shelf id and returns null for an off-shelf one (indistinguishable from absent)", () => {
    const router: VaultRouter = { shelves: () => [A, B], writeTarget: () => A };
    const { store, dataDir } = freshStore(router);
    writeMemoryFile(dataDir, A, mem("mem_mine"));
    writeMemoryFile(dataDir, C, mem("mem_theirs")); // shelf C is NOT in the principal's set

    expect(store.getMemoryForPrincipal(PRINCIPAL, "mem_mine")?.id).toBe("mem_mine");
    expect(store.getMemoryForPrincipal(PRINCIPAL, "mem_theirs")).toBeNull();
    expect(store.getMemoryForPrincipal(PRINCIPAL, "mem_never_existed")).toBeNull();
  });
});

describe("principal-scoped proposal moderation", () => {
  it("refuses the moderation bypass to a non-admin principal", () => {
    const { store } = freshStore(twoShelfRouter);
    const proposal = store
      .forShelf(A)
      .createMemory(
        { title: "Review me", body: "body", agent_id: PRINCIPAL.actorId },
        { requires_approval: true },
      ).memory;

    expect(() => store.approveProposalForPrincipal(PRINCIPAL, proposal.id, "reject")).toThrowError(
      "proposal moderation requires an admin principal",
    );
    expect(store.forShelf(A).getMemory(proposal.id)?.status).toBe("proposed");
  });
});

describe("distinctValuesForPrincipal — union over the shelf set (spec 065 SC 7)", () => {
  it("unions the per-shelf values (multi-shelf) and delegates byte-identically (default router)", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    writeMemoryFile(dataDir, A, mem("mem_1", { agent_id: "zed" }));
    writeMemoryFile(dataDir, A, mem("mem_2", { agent_id: "amy" }));
    writeMemoryFile(dataDir, B, mem("mem_3", { agent_id: "amy" }));
    writeMemoryFile(dataDir, B, mem("mem_4", { agent_id: "bob" }));

    expect(store.distinctValuesForPrincipal(PRINCIPAL, { field: "agent_id" })).toEqual([
      "amy",
      "bob",
      "zed",
    ]);

    const solo = freshStore();
    writeMemoryFile(solo.dataDir, { id: "d", prefix: "", writable: true }, mem("mem_5"));
    expect(solo.store.distinctValuesForPrincipal(PRINCIPAL, { field: "agent_id" })).toEqual(
      solo.store.distinctValues({ field: "agent_id" }),
    );
  });
});

describe("countReferencesForPrincipal — the scoped searched denominator (spec 065 T4)", () => {
  function writeReference(dataDir: string, shelf: Shelf, name: string): void {
    const dir = path.join(
      dataDir,
      "vault",
      ...shelf.prefix.split("/").filter(Boolean),
      "references",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), `# ${name}\n\nreference body\n`);
  }

  it("sums the per-shelf counts (multi-shelf) and matches the main count (default router)", () => {
    const { store, dataDir } = freshStore(twoShelfRouter);
    writeReference(dataDir, A, "ref-a1");
    writeReference(dataDir, A, "ref-a2");
    writeReference(dataDir, B, "ref-b1");
    expect(store.countReferencesForPrincipal(PRINCIPAL)).toBe(3);

    const solo = freshStore();
    writeReference(solo.dataDir, { id: "d", prefix: "", writable: true }, "ref-1");
    expect(solo.store.countReferencesForPrincipal(PRINCIPAL)).toBe(solo.store.countReferences());
    expect(solo.store.countReferencesForPrincipal(PRINCIPAL)).toBe(1);
  });
});

describe("the empty materialised shelf set (062's rule, spec 065 SC 7)", () => {
  it("zero shelves → empty envelope, empty union, null get, zero count — never a throw", () => {
    const { store } = freshStore(zeroShelfRouter);

    expect(store.listMemoriesForPrincipal(PRINCIPAL)).toEqual({
      memories: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    expect(store.listMemoriesForPrincipal(PRINCIPAL, { limit: 7, offset: 3 })).toEqual({
      memories: [],
      total: 0,
      limit: 7,
      offset: 3,
    });
    expect(store.distinctValuesForPrincipal(PRINCIPAL, { field: "agent_id" })).toEqual([]);
    expect(store.getMemoryForPrincipal(PRINCIPAL, "mem_any")).toBeNull();
    expect(store.countReferencesForPrincipal(PRINCIPAL)).toBe(0);
    expect(store.shelvesForPrincipal(PRINCIPAL)).toEqual([]);
  });
});
