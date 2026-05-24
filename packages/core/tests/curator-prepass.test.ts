// Deterministic pre-pass for the curator (spec §10.3).
//
// Before the LLM runs, cheap deterministic findings are computed over the
// gathered memory evidence so the model gets candidates instead of discovering
// everything from scratch: exact duplicates, same-title (differing body),
// proposed memories that duplicate an active one, and resurrection risks
// (matching an archived tombstone, §9.1). Fuzzy "obsolete considering/maybe
// contradicted by a later decision" detection is semantic — left to the LLM.

import {
  type MemoryEvidenceBundle,
  type MemoryEvidenceItem,
  type TombstoneItem,
  curationContentFingerprint,
  curationNormalizedTitle,
  deterministicPrepass,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function mem(
  id: string,
  title: string,
  body: string,
  status: "active" | "proposed" = "active",
): MemoryEvidenceItem {
  return {
    id,
    title,
    body,
    category: "lessons",
    scope: "project",
    visibility: "common",
    projectKey: "p",
    agentId: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function tombstone(id: string, title: string, body: string): TombstoneItem {
  return {
    id,
    title,
    category: "lessons",
    scope: "project",
    visibility: "common",
    projectKey: "p",
    agentId: null,
    archivedAt: "2026-01-01T00:00:00.000Z",
    archiveReason: null,
    contentFingerprint: curationContentFingerprint(title, body),
    normalizedTitle: curationNormalizedTitle(title),
  };
}

function bundle(parts: Partial<MemoryEvidenceBundle>): MemoryEvidenceBundle {
  return {
    slice: { kind: "common_project", projectKey: "p" },
    activeMemories: [],
    proposedMemories: [],
    tombstones: [],
    truncatedMemories: false,
    truncatedFields: false,
    redactionCount: 0,
    ...parts,
  };
}

const kinds = (r: { findings: { kind: string }[] }) => r.findings.map((f) => f.kind);

describe("deterministicPrepass", () => {
  it("flags exact duplicates among active memories", () => {
    const result = deterministicPrepass(
      bundle({ activeMemories: [mem("a", "Title", "Body"), mem("b", "title!", "body.")] }),
    );
    const dup = result.findings.find((f) => f.kind === "exact_duplicate");
    expect(dup).toBeDefined();
    expect(dup!.memoryIds).toEqual(["a", "b"]);
  });

  it("does not flag distinct memories as duplicates", () => {
    const result = deterministicPrepass(
      bundle({ activeMemories: [mem("a", "T1", "B1"), mem("b", "T2", "B2")] }),
    );
    expect(kinds(result)).not.toContain("exact_duplicate");
    expect(kinds(result)).not.toContain("same_title");
  });

  it("flags same-title memories with differing bodies (merge candidate), not as exact duplicates", () => {
    const result = deterministicPrepass(
      bundle({
        activeMemories: [mem("a", "Deploy steps", "do X then Y"), mem("b", "Deploy steps", "do Z")],
      }),
    );
    const same = result.findings.find((f) => f.kind === "same_title");
    expect(same).toBeDefined();
    expect(same!.memoryIds).toEqual(["a", "b"]);
    expect(kinds(result)).not.toContain("exact_duplicate");
  });

  it("flags a proposed memory that duplicates an active one", () => {
    const result = deterministicPrepass(
      bundle({
        activeMemories: [mem("a", "Same", "Same body")],
        proposedMemories: [mem("p", "Same", "Same body", "proposed")],
      }),
    );
    const dup = result.findings.find((f) => f.kind === "proposed_duplicate");
    expect(dup).toBeDefined();
    expect(dup!.memoryIds).toEqual(["a", "p"]);
  });

  it("flags a resurrection risk when content matches an archived tombstone (fingerprint)", () => {
    const result = deterministicPrepass(
      bundle({
        proposedMemories: [mem("p", "Gone", "deleted content", "proposed")],
        tombstones: [tombstone("dead", "Gone", "deleted content")],
      }),
    );
    const risk = result.findings.find((f) => f.kind === "resurrection_risk");
    expect(risk).toBeDefined();
    expect(risk!.memoryIds).toEqual(["p"]);
    expect(risk!.tombstoneId).toBe("dead");
  });

  it("flags a resurrection risk on a normalized-title match alone", () => {
    const result = deterministicPrepass(
      bundle({
        activeMemories: [mem("a", "deprecated approach!", "totally different wording")],
        tombstones: [tombstone("dead", "Deprecated Approach", "we tried X, it failed")],
      }),
    );
    expect(kinds(result)).toContain("resurrection_risk");
  });

  it("does not create same-title noise from empty-normalising titles", () => {
    const result = deterministicPrepass(
      bundle({ activeMemories: [mem("a", "---", "b1"), mem("b", "!!!", "b2")] }),
    );
    expect(kinds(result)).not.toContain("same_title");
  });

  it("does not flag a resurrection risk for empty-normalising content", () => {
    // Both the live memory and the tombstone normalise to empty (no identity) —
    // neither the fingerprint nor the title arm of the match may fire.
    const result = deterministicPrepass(
      bundle({
        activeMemories: [mem("a", "---", "!!!")],
        tombstones: [tombstone("dead", "###", "...")],
      }),
    );
    expect(kinds(result)).not.toContain("resurrection_risk");
  });

  it("returns no findings for an empty bundle", () => {
    expect(deterministicPrepass(bundle({})).findings).toEqual([]);
  });

  it("produces identical output regardless of input ordering (deterministic, §10.2)", () => {
    const active = [mem("a", "Same", "Same"), mem("b", "Same", "Same"), mem("c", "Other", "x")];
    const tombs = [tombstone("dead", "Gone", "deleted content")];
    const forward = deterministicPrepass(
      bundle({
        activeMemories: active,
        proposedMemories: [mem("p", "Gone", "deleted content", "proposed")],
        tombstones: tombs,
      }),
    );
    const reversed = deterministicPrepass(
      bundle({
        activeMemories: [...active].reverse(),
        proposedMemories: [mem("p", "Gone", "deleted content", "proposed")],
        tombstones: tombs,
      }),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
