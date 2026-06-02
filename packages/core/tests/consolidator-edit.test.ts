// Consolidator minimal-edit / no-clobber transforms (plan 036 Phase 4 / spec
// 035 §F5, gaps G5/S18). The consolidator must NEVER rewrite a hand-authored
// doc — augmenting it adds content and leaves the existing prose intact. These
// are pure string transforms; the store wiring (read target → augment → write)
// is a separate increment.

import { augmentBody, preservesOriginal } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("augmentBody (minimal-edit append)", () => {
  it("appends the addition as a new paragraph, preserving the original verbatim", () => {
    const out = augmentBody("Anna lives in Paris.", "She now works at [[Acme]].");
    expect(out).toBe("Anna lives in Paris.\n\nShe now works at [[Acme]].");
    expect(out.startsWith("Anna lives in Paris.")).toBe(true); // original is a prefix → no-clobber
  });

  it("never drops any line of the existing doc", () => {
    const existing = "# Anna\n\n- lives in Paris\n- likes tea";
    const out = augmentBody(existing, "- moved to [[Berlin]] in 2026");
    for (const line of existing.split("\n").filter((l) => l.trim())) {
      expect(out).toContain(line);
    }
    expect(out).toContain("[[Berlin]]");
  });

  it("returns just the addition when the existing doc is empty", () => {
    expect(augmentBody("", "A brand new fact.")).toBe("A brand new fact.");
    expect(augmentBody("   \n  ", "A brand new fact.")).toBe("A brand new fact.");
  });

  it("leaves the doc unchanged when there is nothing to add", () => {
    expect(augmentBody("Existing.", "")).toBe("Existing.");
    expect(augmentBody("Existing.", "   ")).toBe("Existing.");
  });

  it("normalises only trailing whitespace, not content", () => {
    expect(augmentBody("line one\n\n\n", "line two")).toBe("line one\n\nline two");
  });
});

describe("preservesOriginal (no-clobber backstop)", () => {
  it("is true when every non-empty line of the original survives", () => {
    const before = "fact A\nfact B";
    expect(preservesOriginal(before, augmentBody(before, "fact C"))).toBe(true);
  });

  it("is false when a line of the original was dropped (a clobber)", () => {
    expect(preservesOriginal("fact A\nfact B", "fact A\nfact C")).toBe(false);
  });

  it("ignores blank lines + outer whitespace in the original", () => {
    expect(preservesOriginal("\n  fact A  \n\n", "intro\nfact A\nmore")).toBe(true);
  });

  it("is vacuously true for an empty original", () => {
    expect(preservesOriginal("", "anything")).toBe(true);
    expect(preservesOriginal("   \n ", "anything")).toBe(true);
  });
});
