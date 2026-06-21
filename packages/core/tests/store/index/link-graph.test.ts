// Backlink graph tests (plan 036 Phase 3 / spec 035 §F2, §F3 — the "co-mention
// problem"). The graph turns the corpus's wikilinks into outbound + inbound
// (backlink) adjacency so recall can return a fact filed under EITHER entity
// from the other. Pure — built from parseWikilinks over doc bodies.

import { buildLinkGraph } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("buildLinkGraph", () => {
  it("records outbound wikilink targets (deduped, all forms)", () => {
    const graph = buildLinkGraph([
      { id: "a", body: "[[b]] and [[b|again]] and [[c#h]] and ![[d]]" },
    ]);
    expect(graph.outbound("a").sort()).toEqual(["b", "c", "d"]);
  });

  it("records inbound backlinks", () => {
    const graph = buildLinkGraph([
      { id: "sophie", body: "daughter of [[elaine]]" },
      { id: "bob", body: "knows [[elaine]]" },
      { id: "elaine", body: "the matriarch" },
    ]);
    expect(graph.inbound("elaine").sort()).toEqual(["bob", "sophie"]);
    expect(graph.inbound("sophie")).toEqual([]);
  });

  it("solves the co-mention problem: reachable from either entity", () => {
    // A Sophie+Elaine fact filed under sophie, linking [[elaine]].
    const graph = buildLinkGraph([
      { id: "sophie", body: "Sophie is [[elaine]]'s daughter; she loves piano." },
      { id: "elaine", body: "Elaine is the matriarch." },
    ]);
    // From elaine, reach sophie (via the inbound backlink).
    expect(graph.neighbors("elaine")).toContain("sophie");
    // From sophie, reach elaine (via the outbound link).
    expect(graph.neighbors("sophie")).toContain("elaine");
  });

  it("neighbors unions outbound + inbound, deduped, excluding self", () => {
    const graph = buildLinkGraph([
      { id: "a", body: "[[b]] [[c]] [[a]]" }, // self-link ignored
      { id: "b", body: "links back to [[a]]" },
    ]);
    expect(graph.neighbors("a").sort()).toEqual(["b", "c"]);
  });

  it("returns empty arrays for an unknown id", () => {
    const graph = buildLinkGraph([{ id: "a", body: "no links" }]);
    expect(graph.outbound("zzz")).toEqual([]);
    expect(graph.inbound("zzz")).toEqual([]);
    expect(graph.neighbors("zzz")).toEqual([]);
  });
});
