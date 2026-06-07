// @librarian/intake-eval — operator-driven evaluation harness for the
// intake's navigate→judge→route pipeline (plan 036 Phase 4 / the C6
// checkpoint).
//
// Public surface (C6a — fixtures):
//   - the fixture schema + types (a submission, the corpus the judge sees, and
//     the ground-truth action/decision a correct intake should reach);
//   - `loadSeedFixture()` — the bundled S1/S2/S4/S12/S18 seed set.
//
// The operator CLI + frozen baseline land in the follow-on increment (C6c).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IntakeFixtureFileSchema, type IntakeFixtureEntry } from "./fixture.js";

export {
  INTAKE_SCENARIOS,
  JUDGE_ACTIONS,
  ROUTING_DECISIONS,
  IntakeFixtureEntrySchema,
  IntakeFixtureFileSchema,
} from "./fixture.js";
export type {
  IntakeScenario,
  IntakeCorpusDoc,
  IntakeFixtureEntry,
  IntakeFixtureFile,
} from "./fixture.js";

export { runIntakeEval } from "./run.js";
export type { RunIntakeEvalOptions } from "./run.js";
export { scoreSample, summarize } from "./metrics.js";
export type { EvalReport, SampleResult, SampleOutcome, ScenarioBreakdown } from "./metrics.js";
export { scriptedLlmClient } from "./fake-llm.js";
export type { ScriptedJudgment } from "./fake-llm.js";

export {
  BASELINE_METRICS,
  DEFAULT_TOLERANCE,
  BaselineSchema,
  baselineFromReport,
  compareToBaseline,
} from "./baseline.js";
export type { Baseline, BaselineMetric, GateResult, Regression } from "./baseline.js";

/**
 * Load the bundled seed fixture — a small set covering each intake
 * scenario (S1/S2/S4/S12/S18) with both straight and boundary cases. Parsed
 * against the schema, so cross-field invariants (target exists; action↔decision
 * is routing-reachable) are enforced on load.
 */
export function loadSeedFixture(): IntakeFixtureEntry[] {
  const url = new URL("../fixtures/seed-v1.json", import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  return IntakeFixtureFileSchema.parse(JSON.parse(raw));
}
