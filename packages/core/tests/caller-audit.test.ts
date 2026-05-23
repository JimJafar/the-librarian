// Baseline caller-id audit (naming contract §9 Phase 0 / §11 migration dry-run).
//
// `auditCallerIds` is the pure dry-run that the migration tooling uses to show
// how `normaliseCallerId` would collapse the existing stored ids before any
// backfill — collapse groups (multiple raw variants → one canonical) flag where
// attribution would merge, and unnormalisable ids are surfaced separately.

import { auditCallerIds } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("auditCallerIds", () => {
  it("groups raw variants by their canonical form", () => {
    const audit = auditCallerIds(["Guybrush", "guybrush", " guybrush "]);
    expect(audit.groups).toHaveLength(1);
    expect(audit.groups[0]).toEqual({
      canonical: "guybrush",
      variants: [" guybrush ", "Guybrush", "guybrush"],
    });
  });

  it("flags collapse groups (>1 variant) separately from clean ids", () => {
    const audit = auditCallerIds(["Codex", "codex", "claude-code"]);
    expect(audit.collapses.map((g) => g.canonical)).toEqual(["codex"]);
    expect(audit.collapses[0].variants).toEqual(["Codex", "codex"]);
    // claude-code is a single clean variant — present in groups, not a collapse.
    expect(audit.groups.map((g) => g.canonical)).toContain("claude-code");
  });

  it("sorts collapse groups ahead of single-variant groups", () => {
    const audit = auditCallerIds(["zeta", "Alpha", "alpha"]);
    expect(audit.groups[0].canonical).toBe("alpha"); // the collapse group leads
  });

  it("collects ids with no canonical form as invalid", () => {
    const audit = auditCallerIds(["guybrush", "!!!", "   "]);
    expect(audit.invalid).toEqual(["!!!"]);
    expect(audit.groups.map((g) => g.canonical)).toEqual(["guybrush"]);
  });

  it("skips empty / whitespace-only ids without counting them", () => {
    const audit = auditCallerIds(["", "  ", "codex"]);
    expect(audit.total).toBe(1);
    expect(audit.groups).toHaveLength(1);
    expect(audit.invalid).toEqual([]);
  });

  it("dedupes exact-duplicate raw ids", () => {
    const audit = auditCallerIds(["codex", "codex"]);
    expect(audit.groups[0].variants).toEqual(["codex"]);
    expect(audit.total).toBe(1);
  });

  it("reports an empty audit for no input", () => {
    const audit = auditCallerIds([]);
    expect(audit).toEqual({ groups: [], collapses: [], invalid: [], total: 0 });
  });
});
