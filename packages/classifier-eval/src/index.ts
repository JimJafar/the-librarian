// @librarian/classifier-eval — operator-driven evaluation harness.
//
// Public surface:
//   - `runEval()` — runs a classifier over a fixture sample, returns
//     a structured report. Used by the dashboard's eval page and by
//     the CLI bin.
//   - `computeSoftAlert()` — pure function the dashboard's banner
//     calls against recent `memory.classified` events.
//   - `loadSeedFixture()` — convenience helper for the bundled
//     12-entry seed fixture (spec §4.7's public consensus fixture
//     ships in a follow-up — see plan Task 4.10).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FixtureFileSchema, type FixtureEntry } from "./fixture.js";

export type { FixtureEntry, FixtureFile } from "./fixture.js";
export { FixtureEntrySchema, FixtureFileSchema } from "./fixture.js";

export { runEval } from "./run.js";
export type { RunEvalOptions, EvalReport, SampleResult } from "./run.js";

export {
  computeSoftAlert,
  DEFAULT_SOFT_ALERT_WINDOW,
  DEFAULT_SOFT_ALERT_THRESHOLD,
} from "./soft-alert.js";
export type { SoftAlertInput, SoftAlertResult } from "./soft-alert.js";

/**
 * Load the bundled seed fixture (~12 entries covering each verdict
 * quadrant and a few boundary cases). The public consensus-graded
 * fixture from spec §4.7 lands in a follow-up.
 */
export function loadSeedFixture(): FixtureEntry[] {
  const url = new URL("../fixtures/seed-v1.json", import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  return FixtureFileSchema.parse(JSON.parse(raw));
}
