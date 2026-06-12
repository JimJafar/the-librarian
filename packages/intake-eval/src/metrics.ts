// Scoring for the intake eval. Pure functions: given a fixture entry and
// the plan the pipeline produced (or a parse failure), grade one sample; then
// aggregate a run into a report. No I/O, no model — the run engine wires these
// to navigate→judge→route (the route half is the unified D13 rule).
//
// The headline metrics map to the Phase-4 scenarios:
//   - filing_accuracy        — did the judge pick the right action (and target)?
//   - decision_band_accuracy — did confidence route to the right verdict
//     (apply vs propose under the single D13 threshold)?
//   - no_clobber_rate (S18)  — did an edit to a hand-authored doc preserve it?
//   - contradiction_recall (S4) — was a contradicting update superseded?
//   - entity_resolution (S12)   — did an ambiguous merge AVOID a confident
//     wrong-merge (it should propose, never auto-augment)?

import { type IntakeJudgment, augmentBody, preservesOriginal } from "@librarian/core";
import type { IntakeFixtureEntry, IntakeScenario } from "./fixture.js";

/** A judgment + the D13 verdict the run engine derived for it. */
export interface RoutedPlan {
  decision: string;
  judgment: IntakeJudgment;
}

export interface SampleOutcome {
  action: string;
  decision: string;
  target_id?: string;
}

export interface SampleResult {
  id: string;
  scenario: IntakeScenario;
  category: "straight" | "boundary";
  expected: SampleOutcome;
  actual: SampleOutcome | null;
  action_match: boolean;
  decision_match: boolean;
  /** null when the expected action has no target. */
  target_match: boolean | null;
  /** null when the entry doesn't assert preserves_corpus. */
  no_clobber: boolean | null;
  /** action matched AND (no target expected OR the target matched). */
  filed_correctly: boolean;
  parse_error?: string;
}

function judgmentTarget(judgment: IntakeJudgment): string | undefined {
  return "target_id" in judgment ? judgment.target_id : undefined;
}

// Whether an edit to the expected target preserved its existing prose. Vacuously
// true when the judge didn't touch that doc (you can't clobber what you didn't
// edit); the wrong-action case is caught by filing_accuracy, not here.
function computeNoClobber(entry: IntakeFixtureEntry, judgment: IntakeJudgment): boolean {
  const target = entry.corpus.find((doc) => doc.id === entry.expect.target_id);
  if (!target) return true;
  if (judgmentTarget(judgment) !== target.id) return true;
  if (judgment.action === "augment") {
    return preservesOriginal(target.body, augmentBody(target.body, judgment.addition));
  }
  if (judgment.action === "supersede") return preservesOriginal(target.body, judgment.body);
  if (judgment.action === "archive") return false; // removed the doc → its prose is gone
  return true;
}

export function scoreSample(
  entry: IntakeFixtureEntry,
  plan: RoutedPlan | null,
  parseError?: string,
): SampleResult {
  const expected: SampleOutcome = {
    action: entry.expect.action,
    decision: entry.expect.decision,
    ...(entry.expect.target_id ? { target_id: entry.expect.target_id } : {}),
  };
  const base = { id: entry.id, scenario: entry.scenario, category: entry.category, expected };

  // Only grade the target when the fixture says it matters. An entry whose
  // right behaviour is "don't confidently merge" (S12) sets grade_target:false —
  // its named id is an arbitrary tiebreak, and grading it would penalise the
  // correct uncertainty (the apply layer drops a proposal's target anyway).
  const gradeTarget = Boolean(entry.expect.target_id) && entry.expect.grade_target !== false;

  if (!plan) {
    return {
      ...base,
      actual: null,
      action_match: false,
      decision_match: false,
      target_match: gradeTarget ? false : null,
      no_clobber: entry.expect.preserves_corpus ? false : null,
      filed_correctly: false,
      ...(parseError ? { parse_error: parseError } : {}),
    };
  }

  const { judgment } = plan;
  const actualTarget = judgmentTarget(judgment);
  const actual: SampleOutcome = {
    action: judgment.action,
    decision: plan.decision,
    ...(actualTarget ? { target_id: actualTarget } : {}),
  };
  const action_match = judgment.action === entry.expect.action;
  const target_match = gradeTarget ? actualTarget === entry.expect.target_id : null;

  return {
    ...base,
    actual,
    action_match,
    decision_match: plan.decision === entry.expect.decision,
    target_match,
    no_clobber: entry.expect.preserves_corpus ? computeNoClobber(entry, judgment) : null,
    filed_correctly: action_match && target_match !== false,
  };
}

export interface ScenarioBreakdown {
  total: number;
  action_correct: number;
  decision_correct: number;
}

export interface EvalReport {
  sample_size: number;
  filing_accuracy: number;
  decision_band_accuracy: number;
  /** null when no entry asserts preserves_corpus. */
  no_clobber_rate: number | null;
  /** S4: fraction of contradiction cases the judge superseded. null when no S4. */
  contradiction_recall: number | null;
  /** S12: fraction of ambiguous cases that avoided a confident wrong-merge. null when no S12. */
  entity_resolution: number | null;
  parse_error_count: number;
  // Partial: a run over a fixture subset only populates the scenarios it covers.
  by_scenario: Partial<Record<IntakeScenario, ScenarioBreakdown>>;
  samples: SampleResult[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

// A confident, destructive merge: an auto-applied action that touches an existing
// doc (augment / supersede — anything but a fresh create or a noop; archive can
// never reach "apply" under D13). This is the failure S12's entity_resolution
// must catch.
function confidentWrongMerge(outcome: SampleResult["actual"]): boolean {
  if (!outcome || outcome.decision !== "apply") return false;
  return outcome.action !== "create" && outcome.action !== "noop";
}

export function summarize(samples: SampleResult[]): EvalReport {
  const by_scenario: Partial<Record<IntakeScenario, ScenarioBreakdown>> = {};
  for (const sample of samples) {
    const bucket = (by_scenario[sample.scenario] ??= {
      total: 0,
      action_correct: 0,
      decision_correct: 0,
    });
    bucket.total += 1;
    if (sample.action_match) bucket.action_correct += 1;
    if (sample.decision_match) bucket.decision_correct += 1;
  }

  const total = samples.length;
  const clobberable = samples.filter((s) => s.no_clobber !== null);
  const s4 = samples.filter((s) => s.scenario === "S4");
  const s12 = samples.filter((s) => s.scenario === "S12");

  return {
    sample_size: total,
    filing_accuracy: total === 0 ? 0 : samples.filter((s) => s.filed_correctly).length / total,
    decision_band_accuracy:
      total === 0 ? 0 : samples.filter((s) => s.decision_match).length / total,
    no_clobber_rate: ratio(
      clobberable.filter((s) => s.no_clobber === true).length,
      clobberable.length,
    ),
    contradiction_recall: ratio(
      s4.filter((s) => s.actual?.action === "supersede").length,
      s4.length,
    ),
    entity_resolution: ratio(
      s12.filter((s) => !s.parse_error && !confidentWrongMerge(s.actual)).length,
      s12.length,
    ),
    parse_error_count: samples.filter((s) => s.parse_error).length,
    by_scenario,
    samples,
  };
}
