// runConsolidatorEval drives the real navigate→judge→route pipeline over the
// seed fixture with a scripted LLM, and grades the plans. A perfect oracle
// scores 1.0 across the board; a wrong model scores low; a model that returns
// garbage is recorded as a parse failure, never thrown.

import type { IntakeJudgment } from "@librarian/core";
import { describe, expect, it } from "vitest";
import {
  type ConsolidatorFixtureEntry,
  type ScriptedJudgment,
  loadSeedFixture,
  runConsolidatorEval,
  scriptedLlmClient,
} from "../src/index.js";

const fixture = loadSeedFixture();

// A confidence that routes to the entry's expected band under the default
// thresholds (auto_apply ≥0.95, propose ≥0.85, else create_new for augment).
function confidenceFor(decision: string): number {
  switch (decision) {
    case "auto_apply":
      return 0.99;
    case "propose":
      return 0.9;
    case "create_new":
      return 0.5;
    default:
      return 0.99; // skip (noop)
  }
}

// The "model answer" for an entry: the action it expects, at a band-appropriate
// confidence, targeting the corpus doc it names.
function oracleJudgment(entry: ConsolidatorFixtureEntry): IntakeJudgment {
  const confidence = confidenceFor(entry.expect.decision);
  const target = entry.expect.target_id ?? "";
  switch (entry.expect.action) {
    case "create":
      return {
        action: "create",
        title: "New doc",
        body: "Body.",
        tags: [],
        rationale: "r",
        confidence,
      };
    case "augment":
      return {
        action: "augment",
        target_id: target,
        addition: "A fact not already present in the target.",
        rationale: "r",
        confidence,
      };
    case "supersede": {
      // A preserving rewrite when the doc is hand-authored (keep every line);
      // otherwise a plain replacement.
      const doc = entry.corpus.find((d) => d.id === entry.expect.target_id);
      const body =
        entry.expect.preserves_corpus && doc
          ? `${doc.body}\n\nUpdated per the latest submission.`
          : "Replacement.";
      return {
        action: "supersede",
        target_id: target,
        title: "T",
        body,
        rationale: "r",
        confidence,
      };
    }
    case "archive":
      return { action: "archive", target_id: target, rationale: "r", confidence };
    default:
      return { action: "noop", rationale: "r", confidence };
  }
}

function oracleClient() {
  const script: ScriptedJudgment[] = fixture.map((entry) => ({
    match: entry.submission.text,
    judgment: oracleJudgment(entry),
  }));
  return scriptedLlmClient(script);
}

// This proves the fixtures are internally routing-consistent (every expected
// action+decision is reachable through the real routeConsolidation at a
// band-appropriate confidence) and that the navigate→judge→route→score plumbing
// is wired. It does NOT prove the metrics are meaningful or the model is good —
// the discriminating tests below (wrong model, parse error, no-clobber) do that.
describe("runConsolidatorEval — fixtures are routing-consistent (oracle)", () => {
  it("scores 1.0 on every headline metric when fed the expected judgments", async () => {
    const report = await runConsolidatorEval({ fixture, llmClient: oracleClient() });

    expect(report.sample_size).toBe(fixture.length);
    expect(report.filing_accuracy).toBe(1);
    expect(report.decision_band_accuracy).toBe(1);
    expect(report.no_clobber_rate).toBe(1);
    expect(report.contradiction_recall).toBe(1);
    expect(report.entity_resolution).toBe(1);
    expect(report.parse_error_count).toBe(0);
  });

  it("reports every scenario as fully correct", async () => {
    const report = await runConsolidatorEval({ fixture, llmClient: oracleClient() });
    for (const breakdown of Object.values(report.by_scenario)) {
      expect(breakdown.action_correct).toBe(breakdown.total);
      expect(breakdown.decision_correct).toBe(breakdown.total);
    }
  });
});

describe("runConsolidatorEval — a wrong model", () => {
  it("scores poorly but still credits the genuine noop case", async () => {
    // A model that says "noop" to everything: only the redundant-fact entry is right.
    const alwaysNoop = scriptedLlmClient(
      fixture.map((entry) => ({
        match: entry.submission.text,
        judgment: { action: "noop", rationale: "r", confidence: 0.99 } as IntakeJudgment,
      })),
    );
    const report = await runConsolidatorEval({ fixture, llmClient: alwaysNoop });

    const noopEntries = fixture.filter((e) => e.expect.action === "noop").length;
    expect(report.filing_accuracy).toBeCloseTo(noopEntries / fixture.length, 5);
    expect(report.contradiction_recall).toBe(0); // never superseded
  });
});

describe("runConsolidatorEval — unparseable output", () => {
  it("records a parse error instead of throwing", async () => {
    const garbage = scriptedLlmClient([], {
      rawByMatch: Object.fromEntries(fixture.map((e) => [e.submission.text, "not json at all"])),
    });
    const report = await runConsolidatorEval({ fixture, llmClient: garbage });

    expect(report.parse_error_count).toBe(fixture.length);
    expect(report.filing_accuracy).toBe(0);
  });
});

describe("runConsolidatorEval — no-clobber detection (S18)", () => {
  it("flags a supersede that drops the hand-authored prose", async () => {
    const s18 = fixture.find((e) => e.scenario === "S18" && e.expect.preserves_corpus);
    expect(s18).toBeDefined();
    // The model supersedes the doc with a replacement that omits the original lines.
    const clobbering = scriptedLlmClient([
      {
        match: s18!.submission.text,
        judgment: {
          action: "supersede",
          target_id: s18!.expect.target_id!,
          title: "Project Atlas",
          body: "Atlas supports SSO via SAML.",
          rationale: "r",
          confidence: 0.99,
        },
      },
    ]);
    const report = await runConsolidatorEval({ fixture: [s18!], llmClient: clobbering });

    expect(report.no_clobber_rate).toBe(0);
    expect(report.samples[0]!.no_clobber).toBe(false);
  });
});
