// Proposal drift — spec 072 T4 (SC 5).
//
// Given a proposal's curator_note (which carries source_digests from T3) and a
// way to read memories now, decide whether the corpus moved underneath the
// proposal while it sat in the queue.
//
// Three states, and the ordering between them is the whole design:
//   drifted — a source's content changed since drafting. Blocks approve (D3).
//   unknown — we cannot tell: no digest (drafted before 072, D2) or the source
//             no longer resolves. NEVER blocks; treating unknown as drifted
//             would make every proposal already in the queue unapprovable.
//   clean   — every source still digests to what was recorded.
// "drifted" wins over "unknown" so a mixed proposal is still refused.

import { type ProposalDrift, memoryContentDigest, proposalDrift } from "@librarian/core";
import { describe, expect, it } from "vitest";

const SOURCE = { id: "m1", title: "Deploy policy", body: "never deploy on a Friday" };
const OTHER = { id: "m2", title: "Other", body: "other body" };

const corpus = (...memories: { id: string; title: string; body: string }[]) => {
  const byId = new Map(memories.map((m) => [m.id, m]));
  return (id: string) => byId.get(id) ?? null;
};

const noteFor = (...memories: { id: string; title: string; body: string }[]) => ({
  proposed_action: "update",
  supersedes: memories.map((m) => m.id),
  source_digests: Object.fromEntries(memories.map((m) => [m.id, memoryContentDigest(m)])),
});

const statusOf = (drift: ProposalDrift) => drift.status;

describe("proposalDrift (spec 072 SC 5)", () => {
  it("reports clean when the source still digests to what was recorded", () => {
    const drift = proposalDrift(noteFor(SOURCE), corpus(SOURCE));
    expect(statusOf(drift)).toBe("clean");
    expect(drift.sources).toEqual([{ id: "m1", title: "Deploy policy", drifted: false }]);
  });

  it("reports drifted when the body changed since drafting", () => {
    const edited = { ...SOURCE, body: "never deploy after 3pm on a Friday" };
    const drift = proposalDrift(noteFor(SOURCE), corpus(edited));
    expect(statusOf(drift)).toBe("drifted");
    expect(drift.sources[0]!.drifted).toBe(true);
  });

  it("reports drifted when only the title changed", () => {
    const edited = { ...SOURCE, title: "Deployment policy" };
    expect(statusOf(proposalDrift(noteFor(SOURCE), corpus(edited)))).toBe("drifted");
  });

  it("reports unknown for a proposal drafted before digests existed", () => {
    const legacy = { proposed_action: "update", supersedes: ["m1"] };
    expect(statusOf(proposalDrift(legacy, corpus(SOURCE)))).toBe("unknown");
  });

  it("reports unknown when the source no longer resolves", () => {
    expect(statusOf(proposalDrift(noteFor(SOURCE), corpus()))).toBe("unknown");
  });

  it("reports clean for a proposal that supersedes nothing", () => {
    const create = { proposed_action: "create", source: "intake" };
    const drift = proposalDrift(create, corpus(SOURCE));
    expect(statusOf(drift)).toBe("clean");
    expect(drift.sources).toEqual([]);
  });

  it("lets drifted win over unknown on a mixed proposal", () => {
    // m1 drifted; m2 has no recorded digest, so it cannot be checked.
    const note = {
      proposed_action: "merge",
      supersedes: [SOURCE.id, OTHER.id],
      source_digests: { [SOURCE.id]: memoryContentDigest(SOURCE) },
    };
    const drift = proposalDrift(note, corpus({ ...SOURCE, body: "changed" }, OTHER));
    expect(statusOf(drift)).toBe("drifted");
  });

  it("reports every source, not just the first", () => {
    const note = {
      proposed_action: "merge",
      supersedes: [SOURCE.id, OTHER.id],
      source_digests: {
        [SOURCE.id]: memoryContentDigest(SOURCE),
        [OTHER.id]: memoryContentDigest(OTHER),
      },
    };
    const drift = proposalDrift(note, corpus({ ...SOURCE, body: "changed" }, OTHER));
    expect(drift.sources).toHaveLength(2);
    expect(drift.sources.find((s) => s.id === "m1")!.drifted).toBe(true);
    expect(drift.sources.find((s) => s.id === "m2")!.drifted).toBe(false);
  });

  it("tolerates a null note and malformed shapes without throwing", () => {
    expect(statusOf(proposalDrift(null, corpus(SOURCE)))).toBe("clean");
    expect(statusOf(proposalDrift(undefined, corpus(SOURCE)))).toBe("clean");
    expect(statusOf(proposalDrift({ supersedes: "m1", source_digests: 7 }, corpus(SOURCE)))).toBe(
      "clean",
    );
    expect(
      statusOf(proposalDrift({ supersedes: ["m1"], source_digests: null }, corpus(SOURCE))),
    ).toBe("unknown");
  });
});
