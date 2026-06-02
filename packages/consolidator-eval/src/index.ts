// @librarian/consolidator-eval — operator-driven evaluation harness for the
// consolidator's navigate→judge→route pipeline (plan 036 Phase 4 / the C6
// checkpoint).
//
// Public surface (C6a — fixtures):
//   - the fixture schema + types (a submission, the corpus the judge sees, and
//     the ground-truth action/decision a correct consolidator should reach);
//   - `loadSeedFixture()` — the bundled S1/S2/S4/S12/S18 seed set.
//
// The scoring engine, the deterministic fake LLM client, and the CLI land in
// the follow-on increments (C6b/C6c).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConsolidatorFixtureFileSchema, type ConsolidatorFixtureEntry } from "./fixture.js";

export {
  CONSOLIDATOR_SCENARIOS,
  JUDGE_ACTIONS,
  ROUTING_DECISIONS,
  ConsolidatorFixtureEntrySchema,
  ConsolidatorFixtureFileSchema,
} from "./fixture.js";
export type {
  ConsolidatorScenario,
  ConsolidatorCorpusDoc,
  ConsolidatorFixtureEntry,
  ConsolidatorFixtureFile,
} from "./fixture.js";

/**
 * Load the bundled seed fixture — a small set covering each consolidator
 * scenario (S1/S2/S4/S12/S18) with both straight and boundary cases. Parsed
 * against the schema, so cross-field invariants (target exists; action↔decision
 * is routing-reachable) are enforced on load.
 */
export function loadSeedFixture(): ConsolidatorFixtureEntry[] {
  const url = new URL("../fixtures/seed-v1.json", import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  return ConsolidatorFixtureFileSchema.parse(JSON.parse(raw));
}
