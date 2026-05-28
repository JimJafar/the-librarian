// Consensus filter — pure function tests.

import { describe, expect, it } from "vitest";
import { consensusVerdict } from "../src/generate/consensus.js";

const T = { requires_approval: true, is_global: true };
const F = { requires_approval: false, is_global: false };
const MIXED = { requires_approval: true, is_global: false };

describe("consensusVerdict", () => {
  it("returns the verdict when every grader agrees", () => {
    const result = consensusVerdict([T, T, T]);
    expect(result.verdict).toEqual(T);
    expect(result.reason).toBe("");
  });

  it("drops the candidate when a grader returns null (parse failure / provider error)", () => {
    const result = consensusVerdict([T, null, T]);
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe("grader_failed");
  });

  it("drops the candidate on any disagreement, even one boolean", () => {
    expect(consensusVerdict([T, T, MIXED]).reason).toBe("disagreement");
    expect(consensusVerdict([T, F, T]).reason).toBe("disagreement");
  });

  it("drops on empty input", () => {
    const result = consensusVerdict([]);
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe("no votes");
  });

  it("works for any non-zero grader count (the production count is 3 but the filter is family-size-agnostic)", () => {
    expect(consensusVerdict([T]).verdict).toEqual(T);
    expect(consensusVerdict([T, T]).verdict).toEqual(T);
    expect(consensusVerdict([T, T, T, T]).verdict).toEqual(T);
  });
});
