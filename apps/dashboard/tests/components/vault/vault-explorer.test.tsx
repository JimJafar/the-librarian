// Vault tree filter (rethink T18 + D1.x harden): substring-match prune
// keeps directories whose subtree has at least one matching descendant
// so the user gets path context, not a flat result list.

import { describe, expect, it } from "vitest";
import type { VaultTreeNode } from "@/components/vault/types";

const { filterTree } = await import("@/components/vault/vault-explorer");

const tree: VaultTreeNode[] = [
  {
    name: "memories",
    path: "memories",
    type: "dir",
    children: [
      {
        name: "anna-1.md",
        path: "memories/anna-1.md",
        type: "file",
        mtime: "2026-06-12T00:00:00.000Z",
      },
      {
        name: "ben-2.md",
        path: "memories/ben-2.md",
        type: "file",
        mtime: "2026-06-12T00:00:00.000Z",
      },
    ],
  },
  {
    name: "references",
    path: "references",
    type: "dir",
    children: [
      {
        name: "style.md",
        path: "references/style.md",
        type: "file",
        mtime: "2026-06-12T00:00:00.000Z",
      },
    ],
  },
  { name: "primer.md", path: "primer.md", type: "file", mtime: "2026-06-12T00:00:00.000Z" },
];

describe("filterTree", () => {
  it("returns the original tree unchanged when query is empty or whitespace", () => {
    expect(filterTree(tree, "")).toBe(tree);
    expect(filterTree(tree, "   ")).toBe(tree);
  });

  it("keeps files whose path includes the query (case-insensitive)", () => {
    const out = filterTree(tree, "ANNA");
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("memories");
    expect(out[0]?.children).toHaveLength(1);
    expect(out[0]?.children?.[0]?.name).toBe("anna-1.md");
  });

  it("drops directories whose entire subtree filters out", () => {
    const out = filterTree(tree, "style");
    expect(out.map((n) => n.name)).toEqual(["references"]);
    expect(out[0]?.children).toHaveLength(1);
    expect(out[0]?.children?.[0]?.path).toBe("references/style.md");
  });

  it("matches by directory segment so 'memories/' surfaces every file in that dir", () => {
    const out = filterTree(tree, "memories/");
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe("memories");
    expect(out[0]?.children?.map((c) => c.name)).toEqual(["anna-1.md", "ben-2.md"]);
  });

  it("returns an empty list when nothing matches — caller renders the empty state", () => {
    expect(filterTree(tree, "nonexistent-xyz")).toEqual([]);
  });

  it("matches top-level files alongside dir descendants", () => {
    const out = filterTree(tree, ".md");
    // every file matches; every dir survives; primer stays at root.
    expect(out.map((n) => n.name).sort()).toEqual(["memories", "primer.md", "references"]);
  });
});
