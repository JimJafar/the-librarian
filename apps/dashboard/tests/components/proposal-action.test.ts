import { describe, expect, it } from "vitest";
import { proposalBadge, approveConsequenceLabel } from "@/components/memories/proposal-action";

// The badge/consequence helper is the D5 mapping made testable in isolation —
// no DOM, no server. It decides what an operator sees on a proposal row: an
// authoritative target-implying badge (Update / Replace / Merge / Split) ONLY
// when the proposal carries resolved targets, and an honest "New — needs
// filing" for an intake submission the curator couldn't place. The Approve
// button's label states the archival consequence when sources will be archived.

describe("proposalBadge — the D5 action-badge mapping", () => {
  it("badges a grooming update with a target as an authoritative Update", () => {
    const badge = proposalBadge({ action: "update", targetCount: 1 });
    expect(badge.label).toBe("Update");
    expect(badge.authoritative).toBe(true);
  });

  it("badges a grooming supersede with a target as Replace", () => {
    expect(proposalBadge({ action: "supersede", targetCount: 1 }).label).toBe("Replace");
  });

  it("badges a merge as Merge", () => {
    expect(proposalBadge({ action: "merge", targetCount: 2 }).label).toBe("Merge");
  });

  it("badges a split as Split", () => {
    expect(proposalBadge({ action: "split", targetCount: 1 }).label).toBe("Split");
  });

  it("badges a grooming create that carries a target as New", () => {
    const badge = proposalBadge({ action: "create", targetCount: 1 });
    expect(badge.label).toBe("New");
    expect(badge.authoritative).toBe(true);
  });

  it("badges a target-less intake create as 'New — needs filing', not authoritative", () => {
    const badge = proposalBadge({ action: "create", targetCount: 0 });
    expect(badge.label).toBe("New — needs filing");
    expect(badge.authoritative).toBe(false);
  });

  it("never shows an authoritative Replace badge for a target-less intake supersede", () => {
    // The curator's guessed action is preserved only as descriptive text — the
    // badge itself must not assert a Replace that has nothing to replace.
    const badge = proposalBadge({ action: "supersede", targetCount: 0 });
    expect(badge.label).toBe("New — needs filing");
    expect(badge.authoritative).toBe(false);
    expect(badge.guessedAction).toBe("supersede");
  });

  it("badges a target-less intake augment as 'New — needs filing' keeping the guess", () => {
    const badge = proposalBadge({ action: "augment", targetCount: 0 });
    expect(badge.label).toBe("New — needs filing");
    expect(badge.guessedAction).toBe("augment");
  });

  it("falls back to a plain New badge for an unknown/absent action with no target", () => {
    expect(proposalBadge({ action: null, targetCount: 0 }).label).toBe("New — needs filing");
  });
});

describe("approveConsequenceLabel — Approve states the archival consequence", () => {
  it("reads 'Approve — replaces 1 memory' for a single-target replacement", () => {
    expect(approveConsequenceLabel({ action: "update", targetCount: 1 })).toBe(
      "Approve — replaces 1 memory",
    );
  });

  it("reads 'Approve — merges 3 memories' for a 3-source merge", () => {
    expect(approveConsequenceLabel({ action: "merge", targetCount: 3 })).toBe(
      "Approve — merges 3 memories",
    );
  });

  it("reads a plain 'Approve' for a create that archives nothing", () => {
    expect(approveConsequenceLabel({ action: "create", targetCount: 0 })).toBe("Approve");
  });

  it("reads a plain 'Approve' for a target-less intake proposal", () => {
    expect(approveConsequenceLabel({ action: "supersede", targetCount: 0 })).toBe("Approve");
  });

  it("does not promise archival for a split — its source is archived separately", () => {
    // D4: approving one split replacement must not archive the shared source, so
    // the button must not claim it will. Plain Approve.
    expect(approveConsequenceLabel({ action: "split", targetCount: 1 })).toBe("Approve");
  });
});
