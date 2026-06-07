// Under-evaluation force-propose routing rule (spec 044 D-3). The small shared
// decision both apply paths reduce to: while a job is under_evaluation, divert a
// would-be auto-apply to a proposal and a would-be auto-archive to a skip; tag the
// produced proposals with the addendum eval version. Pure functions, no store.

import { forceProposeDeps, tagAddendumVersion, underEvaluationRoute } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("underEvaluationRoute (spec 044 D-3)", () => {
  it("routes a would-be apply to propose (not archive)", () => {
    expect(underEvaluationRoute("apply", false)).toBe("propose");
  });

  it("routes a would-be auto-ARCHIVE to skip — the archive wrinkle", () => {
    expect(underEvaluationRoute("apply", true)).toBe("skip");
  });

  it("passes a propose through unchanged (a protected-propose stays propose)", () => {
    expect(underEvaluationRoute("propose", false)).toBe("propose");
    expect(underEvaluationRoute("propose", true)).toBe("propose");
  });

  it("passes a skip through unchanged", () => {
    expect(underEvaluationRoute("skip", false)).toBe("skip");
    expect(underEvaluationRoute("skip", true)).toBe("skip");
  });

  it("never returns 'apply' for an under-eval op (nothing auto-applies)", () => {
    expect(underEvaluationRoute("apply", false)).not.toBe("apply");
    expect(underEvaluationRoute("apply", true)).not.toBe("apply");
  });
});

describe("tagAddendumVersion (spec 044 D-3)", () => {
  it("stamps the version onto the note", () => {
    expect(tagAddendumVersion({}, "abc123")).toEqual({ addendum_version: "abc123" });
  });

  it("adds NO key for a null/empty/undefined version (accepted-path note unchanged)", () => {
    expect(tagAddendumVersion({}, null)).toEqual({});
    expect(tagAddendumVersion({}, undefined)).toEqual({});
    expect(tagAddendumVersion({}, "")).toEqual({});
  });

  it("preserves existing keys", () => {
    expect(tagAddendumVersion({ run_id: "r" }, "v")).toEqual({
      run_id: "r",
      addendum_version: "v",
    });
  });
});

describe("forceProposeDeps (spec 044 D-3)", () => {
  it("accepted → an empty spread (byte-identical to before D3a)", () => {
    expect(forceProposeDeps({ status: "accepted", evalVersion: null })).toEqual({});
    expect(forceProposeDeps({ status: "accepted", evalVersion: "ignored" })).toEqual({});
  });

  it("under_evaluation → turns force-propose on with the eval version", () => {
    expect(forceProposeDeps({ status: "under_evaluation", evalVersion: "v1" })).toEqual({
      underEvaluation: true,
      addendumVersion: "v1",
    });
  });

  it("under_evaluation with a null version still turns force-propose on", () => {
    expect(forceProposeDeps({ status: "under_evaluation", evalVersion: null })).toEqual({
      underEvaluation: true,
      addendumVersion: null,
    });
  });
});
