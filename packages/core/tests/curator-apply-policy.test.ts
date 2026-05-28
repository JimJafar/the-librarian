// Curator apply-decision policy (spec §11 table) — the pure rules that map a
// validated operation + the admin default_auto_apply level + confidence threshold
// to auto_apply / propose / skip. These are the un-relaxable guards: protected
// categories NEVER auto-apply (even at high_confidence), and `safe_only` only
// auto-applies `safe`-risk ops. Execution is a separate layer.

import {
  type AcceptedClassification,
  type ApplyPolicy,
  type CuratorOperation,
  decideApply,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

const policy = (level: ApplyPolicy["level"], confidenceThreshold = 0.9): ApplyPolicy => ({
  level,
  confidenceThreshold,
});

const mem = {
  title: "t",
  body: "b",
  category: "lessons" as const,
  visibility: "common" as const,
  scope: "project" as const,
};

function op(type: CuratorOperation["type"], confidence = 0.95): CuratorOperation {
  switch (type) {
    case "noop":
      return { type, source_memory_ids: [], rationale: "r", confidence };
    case "archive":
      return { type, source_memory_ids: ["m"], rationale: "r", confidence };
    case "update":
      return { type, source_memory_id: "m", patch: { body: "x" }, rationale: "r", confidence };
    case "merge":
      return { type, source_memory_ids: ["a", "b"], replacement: mem, rationale: "r", confidence };
    case "split":
      return {
        type,
        source_memory_id: "m",
        replacements: [mem, { ...mem, title: "u" }],
        rationale: "r",
        confidence,
      };
    case "create":
      return { type, memory: mem, rationale: "r", confidence };
  }
}

const accepted = (
  risk: AcceptedClassification["risk"],
  isProtected = false,
): AcceptedClassification => ({
  risk,
  isProtected,
});

describe("decideApply — protected guard (un-relaxable)", () => {
  it("routes protected create/update/merge/split to a proposal at every level", () => {
    for (const level of ["off", "safe_only", "high_confidence"] as const) {
      for (const type of ["create", "update", "merge", "split"] as const) {
        expect(decideApply(op(type), accepted("protected", true), policy(level))).toBe("propose");
      }
    }
  });

  it("never auto-applies a protected op even at high_confidence with max confidence", () => {
    expect(
      decideApply(op("update", 1), accepted("protected", true), policy("high_confidence", 0)),
    ).toBe("propose");
  });

  it("skips a protected pure archive (no replacement to propose)", () => {
    for (const level of ["off", "safe_only", "high_confidence"] as const) {
      expect(decideApply(op("archive"), accepted("protected", true), policy(level))).toBe("skip");
    }
  });
});

describe("decideApply — noop", () => {
  it("always skips (nothing to apply)", () => {
    expect(decideApply(op("noop"), accepted("safe"), policy("high_confidence", 0))).toBe("skip");
  });
});

describe("decideApply — off", () => {
  it("applies nothing, even a high-confidence safe op", () => {
    expect(decideApply(op("archive", 1), accepted("safe"), policy("off"))).toBe("skip");
  });
});

describe("decideApply — safe_only (v1 default)", () => {
  it("auto-applies a safe op at/above the threshold", () => {
    expect(decideApply(op("merge", 0.9), accepted("safe"), policy("safe_only", 0.9))).toBe(
      "auto_apply",
    );
  });

  it("skips a safe op below the threshold", () => {
    expect(decideApply(op("merge", 0.89), accepted("safe"), policy("safe_only", 0.9))).toBe("skip");
  });

  it("skips non-safe ops (normal/risky) even at high confidence", () => {
    expect(decideApply(op("create", 1), accepted("normal"), policy("safe_only"))).toBe("skip");
    expect(decideApply(op("update", 1), accepted("risky"), policy("safe_only"))).toBe("skip");
  });
});

describe("decideApply — high_confidence", () => {
  it("auto-applies any non-protected op at/above the threshold", () => {
    for (const risk of ["safe", "normal", "risky"] as const) {
      expect(decideApply(op("update", 0.9), accepted(risk), policy("high_confidence", 0.9))).toBe(
        "auto_apply",
      );
    }
  });

  it("skips below the threshold", () => {
    expect(decideApply(op("update", 0.5), accepted("risky"), policy("high_confidence", 0.9))).toBe(
      "skip",
    );
  });
});
