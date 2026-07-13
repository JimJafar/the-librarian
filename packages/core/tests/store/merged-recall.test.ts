// Merged multi-shelf recall + provenance labels (spec 062 T5 — SC 5 + the §4 is_global pin).
//   - mergeShelfRecalls: the DECIDED merge rule in isolation (deterministic, synthetic hits) —
//     per-shelf rank interleave with strict alternation + router-order priority, dedupe by memory
//     id (first occurrence wins), limit AFTER the merge, and shelf tagging (labelled / unlabelled).
//   - recallForPrincipal: the store wiring — a two-shelf router tags provenance; the DEFAULT
//     router returns plain Memory objects with NO shelf fields (the inertness rule, T5).
//   - is_global is orthogonal + shelf-local (§4): a global memory on shelf B never appears when
//     recalling only shelf A, and never crosses a shelf boundary.

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
  mergeShelfRecalls,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

// Shelf A (labelled, higher precedence) before shelf B (unlabelled) in router order.
const A: Shelf = { id: "personal", prefix: "members/x/", writable: true, label: "Sarah's shelf" };
const B: Shelf = { id: "team", prefix: "team/", writable: true };
const PRINCIPAL: Principal = { kind: "agent", actorId: "x", roles: ["agent"] };

/** A full, valid Memory — only `id` (and any overrides) vary per test. */
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

describe("mergeShelfRecalls — the decided merge rule (spec 062 SC 5)", () => {
  it("interleaves per-shelf ranks with UNEQUAL sizes: A(2) before B(5) → A1,B1,A2,B2,B3,B4,B5", () => {
    const merged = mergeShelfRecalls(
      [
        { shelf: A, hits: [mem("a1"), mem("a2")] },
        { shelf: B, hits: [mem("b1"), mem("b2"), mem("b3"), mem("b4"), mem("b5")] },
      ],
      100,
    );
    expect(merged.map((m) => m.id)).toEqual(["a1", "b1", "a2", "b2", "b3", "b4", "b5"]);
  });

  it("tags every hit with its shelf: labelled shelf carries shelfLabel, unlabelled does not", () => {
    const merged = mergeShelfRecalls(
      [
        { shelf: A, hits: [mem("a1")] },
        { shelf: B, hits: [mem("b1")] },
      ],
      100,
    );
    const a1 = merged.find((m) => m.id === "a1");
    expect(a1?.shelfId).toBe("personal");
    expect(a1?.shelfLabel).toBe("Sarah's shelf");
    const b1 = merged.find((m) => m.id === "b1");
    expect(b1?.shelfId).toBe("team");
    expect(b1?.shelfLabel).toBeUndefined();
  });

  it("dedupes by memory id — the first (highest-precedence) shelf's copy wins, the later drops", () => {
    const shared = mem("shared");
    const merged = mergeShelfRecalls(
      [
        { shelf: A, hits: [shared, mem("a1")] },
        { shelf: B, hits: [shared, mem("b1")] },
      ],
      100,
    );
    // `shared` appears ONCE, tagged with A (the earlier shelf); B's copy is dropped.
    expect(merged.map((m) => m.id)).toEqual(["shared", "a1", "b1"]);
    expect(merged.filter((m) => m.id === "shared")).toHaveLength(1);
    expect(merged.find((m) => m.id === "shared")?.shelfId).toBe("personal");
  });

  it("applies the limit AFTER the merge — a dropped duplicate never wastes a slot", () => {
    const shared = mem("shared");
    const merged = mergeShelfRecalls(
      [
        { shelf: A, hits: [shared, mem("a1")] },
        { shelf: B, hits: [shared, mem("b1"), mem("b2")] },
      ],
      2,
    );
    // rank0: shared(A), B's shared dropped; rank1: a1 → limit 2 reached. B's b1/b2 never emitted.
    expect(merged.map((m) => m.id)).toEqual(["shared", "a1"]);
  });
});

// ── Store-level wiring ──────────────────────────────────────────────────────────────────────
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

function freshStore(router?: VaultRouter): LibrarianStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-merged-recall-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, ...(router ? { vaultRouter: router } : {}) });
  stores.push(store);
  return store;
}

describe("recallForPrincipal — store wiring (spec 062 SC 5)", () => {
  const twoShelfRouter: VaultRouter = {
    shelves: () => [A, B],
    writeTarget: () => A,
  };

  it("a two-shelf recall tags each hit with its shelf; the default router adds NO shelf fields", async () => {
    // Multi-shelf: provenance tagged.
    const merged = freshStore(twoShelfRouter);
    merged.forShelf(A).createMemory({ title: "A note", body: "piano tuning", agent_id: "x" }, {});
    merged.forShelf(B).createMemory({ title: "B note", body: "piano roster", agent_id: "x" }, {});

    const hits = await merged.recallForPrincipal(PRINCIPAL, { query: "piano" });
    const fromA = hits.find((m) => m.title === "A note");
    const fromB = hits.find((m) => m.title === "B note");
    expect(fromA?.shelfId).toBe("personal");
    expect(fromA?.shelfLabel).toBe("Sarah's shelf");
    expect(fromB?.shelfId).toBe("team");
    expect(fromB?.shelfLabel).toBeUndefined();

    // Single (default) shelf: byte-level inertness — the wire result carries NO shelf fields.
    const solo = freshStore();
    solo.createMemory({ title: "Solo note", body: "piano solo", agent_id: "x" }, {});
    const soloHits = await solo.recallForPrincipal(PRINCIPAL, { query: "piano" });
    expect(soloHits.length).toBeGreaterThan(0);
    for (const hit of soloHits) {
      expect(hit).not.toHaveProperty("shelfId");
      expect(hit).not.toHaveProperty("shelfLabel");
    }
  });

  it("is_global is orthogonal + SHELF-LOCAL: a global on B never leaks into a shelf-A recall (§4)", async () => {
    const store = freshStore(twoShelfRouter);
    // A global memory on EACH shelf, both matching the same query keyword.
    store
      .forShelf(A)
      .createMemory(
        { title: "Global A", body: "piano identity alpha", agent_id: "x" },
        { is_global: true },
      );
    store
      .forShelf(B)
      .createMemory(
        { title: "Global B", body: "piano identity beta", agent_id: "x" },
        { is_global: true },
      );

    // Recalling ONLY shelf A sees A's global, never B's — and vice versa (no cross-shelf leak).
    const aOnly = await store.forShelf(A).recall({ query: "piano" });
    expect(aOnly.map((m) => m.title)).toContain("Global A");
    expect(aOnly.map((m) => m.title)).not.toContain("Global B");
    const bOnly = await store.forShelf(B).recall({ query: "piano" });
    expect(bOnly.map((m) => m.title)).toContain("Global B");
    expect(bOnly.map((m) => m.title)).not.toContain("Global A");

    // The merged recall returns BOTH — each tagged with ITS OWN shelf (is_global never jumps a
    // memory across shelves; the merge never reads is_global, so it grants no cross-shelf boost),
    // and the is_global axis rides through unchanged (per-shelf behaviour preserved).
    const merged = await store.recallForPrincipal(PRINCIPAL, { query: "piano" });
    const ga = merged.find((m) => m.title === "Global A");
    const gb = merged.find((m) => m.title === "Global B");
    expect(ga?.shelfId).toBe("personal");
    expect(ga?.is_global).toBe(true);
    expect(gb?.shelfId).toBe("team");
    expect(gb?.is_global).toBe(true);
    // Neither global is tagged with the OTHER shelf.
    expect(merged.filter((m) => m.title === "Global A")).toHaveLength(1);
    expect(merged.filter((m) => m.title === "Global B")).toHaveLength(1);
  });
});
