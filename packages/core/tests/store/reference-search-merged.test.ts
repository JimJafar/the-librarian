// Merged multi-shelf reference search + provenance labels (spec 062 T6 — SC 8c). Mirrors the T5
// merged-recall shape, over references instead of memories:
//   - mergeShelfReferenceHits: the DECIDED merge rule in isolation (per-shelf rank interleave with
//     strict alternation + router-order priority, dedupe by the reference PATH/id — first occurrence
//     wins, limit AFTER the merge, shelf tagging labelled / unlabelled).
//   - searchReferencesForPrincipal: the store wiring — a two-shelf router tags provenance; the
//     DEFAULT router returns plain ReferenceHit objects with NO shelf fields (the inertness rule).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type ReferenceHit,
  type Shelf,
  type VaultRouter,
  createLibrarianStore,
  mergeShelfReferenceHits,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const A: Shelf = { id: "personal", prefix: "members/x/", writable: true, label: "Sarah's shelf" };
const B: Shelf = { id: "team", prefix: "team/", writable: true };
const PRINCIPAL: Principal = { kind: "agent", actorId: "x", roles: ["agent"] };

/** A full, valid ReferenceHit — only `id` (and any overrides) vary per test. */
function hit(id: string, extra: Partial<ReferenceHit> = {}): ReferenceHit {
  return { id, score: 1, section: `section ${id}`, anchor: "", startChar: 0, endChar: 1, ...extra };
}

describe("mergeShelfReferenceHits — the decided merge rule (spec 062 SC 8c)", () => {
  it("interleaves per-shelf ranks with UNEQUAL sizes: A(2) before B(3) → a1,b1,a2,b2,b3", () => {
    const merged = mergeShelfReferenceHits(
      [
        { shelf: A, hits: [hit("references/a1.md"), hit("references/a2.md")] },
        {
          shelf: B,
          hits: [hit("references/b1.md"), hit("references/b2.md"), hit("references/b3.md")],
        },
      ],
      100,
    );
    expect(merged.map((h) => h.id)).toEqual([
      "references/a1.md",
      "references/b1.md",
      "references/a2.md",
      "references/b2.md",
      "references/b3.md",
    ]);
  });

  it("tags every hit with its shelf: labelled shelf carries shelfLabel, unlabelled does not", () => {
    const merged = mergeShelfReferenceHits(
      [
        { shelf: A, hits: [hit("references/a1.md")] },
        { shelf: B, hits: [hit("references/b1.md")] },
      ],
      100,
    );
    const a1 = merged.find((h) => h.id === "references/a1.md");
    expect(a1?.shelfId).toBe("personal");
    expect(a1?.shelfLabel).toBe("Sarah's shelf");
    const b1 = merged.find((h) => h.id === "references/b1.md");
    expect(b1?.shelfId).toBe("team");
    expect(b1?.shelfLabel).toBeUndefined();
  });

  it("keeps DISTINCT documents that share a relative path across shelves (review C)", () => {
    // Two DIFFERENT files that happen to share the shelf-relative path `references/shared.md`:
    // `members/x/references/shared.md` (A) and `team/references/shared.md` (B). Disjoint prefixes
    // mean these are distinct documents — deduping on the shelf-relative id alone would drop one.
    // The dedupe key is `shelf.prefix + hit.id`, so BOTH survive, each tagged with its own shelf.
    const merged = mergeShelfReferenceHits(
      [
        { shelf: A, hits: [hit("references/shared.md"), hit("references/a1.md")] },
        { shelf: B, hits: [hit("references/shared.md"), hit("references/b1.md")] },
      ],
      100,
    );
    // Interleaved: A's shared, B's shared, A's a1, B's b1 — both `shared` rows present.
    expect(merged.map((h) => h.id)).toEqual([
      "references/shared.md",
      "references/shared.md",
      "references/a1.md",
      "references/b1.md",
    ]);
    const shared = merged.filter((h) => h.id === "references/shared.md");
    expect(shared).toHaveLength(2);
    expect(shared.map((h) => h.shelfId)).toEqual(["personal", "team"]);
  });

  it("applies the limit AFTER the merge — nothing is dropped, so distinct docs fill their slots", () => {
    const merged = mergeShelfReferenceHits(
      [
        { shelf: A, hits: [hit("references/shared.md"), hit("references/a1.md")] },
        {
          shelf: B,
          hits: [hit("references/shared.md"), hit("references/b1.md"), hit("references/b2.md")],
        },
      ],
      2,
    );
    // First two of the interleave: A's shared, then B's shared (a distinct doc — not deduped away).
    expect(merged.map((h) => h.id)).toEqual(["references/shared.md", "references/shared.md"]);
    expect(merged.map((h) => h.shelfId)).toEqual(["personal", "team"]);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-ref-merged-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, ...(router ? { vaultRouter: router } : {}) });
  stores.push(store);
  return store;
}

describe("searchReferencesForPrincipal — store wiring (spec 062 SC 8c)", () => {
  const twoShelfRouter: VaultRouter = { shelves: () => [A, B], writeTarget: () => A };

  it("a two-shelf search tags each hit with its shelf; the default router adds NO shelf fields", async () => {
    // Multi-shelf: a reference on EACH shelf, both matching the same query.
    const merged = freshStore(twoShelfRouter);
    merged
      .forShelf(A)
      .vaultFiles.createFile(
        "members/x/references/piano-a.md",
        "# Piano A\n\nthe grand piano needs tuning twice a year",
      );
    merged
      .forShelf(B)
      .vaultFiles.createFile(
        "team/references/piano-b.md",
        "# Piano B\n\nthe team piano roster and tuning schedule",
      );

    const hits = await merged.searchReferencesForPrincipal(PRINCIPAL, "piano tuning");
    const fromA = hits.find((h) => h.id === "references/piano-a.md");
    const fromB = hits.find((h) => h.id === "references/piano-b.md");
    expect(fromA?.shelfId).toBe("personal");
    expect(fromA?.shelfLabel).toBe("Sarah's shelf");
    expect(fromB?.shelfId).toBe("team");
    expect(fromB?.shelfLabel).toBeUndefined();

    // Single (default) shelf: byte-level inertness — the wire result carries NO shelf fields, so the
    // search_references JSON is unchanged.
    const solo = freshStore();
    solo.vaultFiles.createFile(
      "references/piano-solo.md",
      "# Piano Solo\n\nthe solo piano tuning manual",
    );
    const soloHits = await solo.searchReferencesForPrincipal(PRINCIPAL, "piano tuning");
    expect(soloHits.length).toBeGreaterThan(0);
    for (const h of soloHits) {
      expect(h).not.toHaveProperty("shelfId");
      expect(h).not.toHaveProperty("shelfLabel");
    }
    // The single-shelf id is the shelf-relative reference path, exactly as the legacy search returns.
    expect(soloHits[0]?.id).toBe("references/piano-solo.md");
  });
});
