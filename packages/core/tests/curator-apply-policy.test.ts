// The ONE curator apply rule (rethink D13, spec §5.3) — the single decision
// function both consumers (intake apply + grooming apply) route through:
//
//   - noop never mutates anything → skip;
//   - archive and split ALWAYS propose (the only two operations that destroy or
//     restructure information — enforced by operation TYPE, never by the model's
//     self-reported risk);
//   - any operation targeting a requires_approval memory proposes regardless of
//     confidence;
//   - the submission-level forceProposal hint (ADR 0004) is an upstream override
//     that proposes regardless of everything but noop;
//   - what's left (create/update/merge) applies at confidence ≥ threshold, else
//     proposes.
//
// The full matrix is pinned here: every operation type × confidence
// below/at/above the threshold × requires_approval × forceProposal.

import {
  APPLY_CONFIDENCE_THRESHOLD_KEY,
  type ApplyDecision,
  type CuratorOperationType,
  DEFAULT_APPLY_CONFIDENCE_THRESHOLD,
  decideApplication,
  readApplyConfidenceThreshold,
  writeApplyConfidenceThreshold,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

const OPERATIONS: CuratorOperationType[] = [
  "create",
  "update",
  "merge",
  "split",
  "archive",
  "noop",
];
const THRESHOLD = 0.8;
const BANDS = [
  { label: "below", confidence: 0.79 },
  { label: "at", confidence: 0.8 },
  { label: "above", confidence: 0.95 },
] as const;

// The expected verdict, restated from the spec (NOT derived from the
// implementation): noop is inert; archive/split always propose; the
// forceProposal and requires_approval guards propose; the rest gate on the
// threshold.
function expected(
  operation: CuratorOperationType,
  confidence: number,
  requiresApproval: boolean,
  forceProposal: boolean,
): ApplyDecision {
  if (operation === "noop") return "skip";
  if (forceProposal) return "propose";
  if (requiresApproval) return "propose";
  if (operation === "archive" || operation === "split") return "propose";
  return confidence >= THRESHOLD ? "apply" : "propose";
}

describe("decideApplication — the D13 matrix (op × confidence band × requires_approval × forceProposal)", () => {
  for (const operation of OPERATIONS) {
    for (const band of BANDS) {
      for (const targetRequiresApproval of [false, true]) {
        for (const forceProposal of [false, true]) {
          const want = expected(operation, band.confidence, targetRequiresApproval, forceProposal);
          it(`${operation} / confidence ${band.label} threshold / requires_approval=${targetRequiresApproval} / forceProposal=${forceProposal} → ${want}`, () => {
            expect(
              decideApplication({
                operation,
                confidence: band.confidence,
                threshold: THRESHOLD,
                targetRequiresApproval,
                forceProposal,
              }),
            ).toBe(want);
          });
        }
      }
    }
  }

  it("forceProposal omitted defaults to false (apply at/above threshold)", () => {
    expect(
      decideApplication({
        operation: "create",
        confidence: 0.9,
        threshold: 0.8,
        targetRequiresApproval: false,
      }),
    ).toBe("apply");
  });

  it("archive/split never apply even at confidence 1.0 with a zero threshold", () => {
    for (const operation of ["archive", "split"] as const) {
      expect(
        decideApplication({
          operation,
          confidence: 1,
          threshold: 0,
          targetRequiresApproval: false,
        }),
      ).toBe("propose");
    }
  });

  it("a requires_approval target never applies even at confidence 1.0", () => {
    expect(
      decideApplication({
        operation: "update",
        confidence: 1,
        threshold: 0,
        targetRequiresApproval: true,
      }),
    ).toBe("propose");
  });
});

// ── The single settings knob: curator.apply.confidence_threshold ────────────

function fakeSettings(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getSetting: (key: string) => map.get(key) ?? null,
    listSettings: () => [],
    setSetting: (key: string, value: string) => void map.set(key, value),
    deleteSetting: (key: string) => void map.delete(key),
    map,
  };
}

describe("curator.apply.confidence_threshold — the single knob", () => {
  it("defaults to 0.8 (spec §15.3) when nothing is set", () => {
    expect(readApplyConfidenceThreshold(fakeSettings())).toBe(0.8);
    expect(DEFAULT_APPLY_CONFIDENCE_THRESHOLD).toBe(0.8);
  });

  it("reads the new shared key when set", () => {
    const store = fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "0.92" });
    expect(readApplyConfidenceThreshold(store)).toBe(0.92);
  });

  it("migrates-on-read from the legacy grooming threshold key", () => {
    const store = fakeSettings({ "curator.grooming.auto_apply_confidence": "0.7" });
    expect(readApplyConfidenceThreshold(store)).toBe(0.7);
  });

  it("migrates-on-read from the pre-045 umbrella key when the grooming key is absent", () => {
    const store = fakeSettings({ "curator.auto_apply_confidence": "0.65" });
    expect(readApplyConfidenceThreshold(store)).toBe(0.65);
  });

  it("the new key wins over both legacy keys", () => {
    const store = fakeSettings({
      [APPLY_CONFIDENCE_THRESHOLD_KEY]: "0.85",
      "curator.grooming.auto_apply_confidence": "0.7",
      "curator.auto_apply_confidence": "0.6",
    });
    expect(readApplyConfidenceThreshold(store)).toBe(0.85);
  });

  it("a corrupt or out-of-range stored value falls back to the 0.8 default", () => {
    expect(
      readApplyConfidenceThreshold(fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "nope" })),
    ).toBe(0.8);
    expect(
      readApplyConfidenceThreshold(fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "1.5" })),
    ).toBe(0.8);
    expect(
      readApplyConfidenceThreshold(fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "-1" })),
    ).toBe(0.8);
  });

  it("writeApplyConfidenceThreshold persists a valid value and rejects out-of-range with a teaching error", () => {
    const store = fakeSettings();
    writeApplyConfidenceThreshold(store, 0.75);
    expect(store.map.get(APPLY_CONFIDENCE_THRESHOLD_KEY)).toBe("0.75");
    expect(() => writeApplyConfidenceThreshold(store, 1.2)).toThrow(/between 0 and 1/);
    expect(() => writeApplyConfidenceThreshold(store, Number.NaN)).toThrow(/between 0 and 1/);
  });
});
