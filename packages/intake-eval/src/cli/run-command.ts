// `intake-eval run` — parse flags, build an LLM client from the eval env
// vars (an OpenAI-compatible endpoint: a hosted model or a local ollama/vllm/
// llama.cpp server), run the eval over a fixture, print the report, and
// optionally gate against a frozen baseline.
//
// `buildClient` is injectable so the command can be driven end-to-end in tests
// with a scripted model; the default builds the real remote client.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type LlmClient, type LlmClientConfig, createGroomingLlmClient } from "@librarian/core";
import {
  type GateResult,
  BaselineSchema,
  baselineFromReport,
  compareToBaseline,
} from "../baseline.js";
import { IntakeFixtureFileSchema, type IntakeFixtureEntry } from "../fixture.js";
import { type EvalReport, loadSeedFixture, runIntakeEval } from "../index.js";

export const ENV_ENDPOINT = "LIBRARIAN_INTAKE_EVAL_ENDPOINT";
export const ENV_TOKEN = "LIBRARIAN_INTAKE_EVAL_TOKEN";

export interface RunCommandFlags {
  model: string;
  json: boolean;
  dryRun: boolean;
  gate: boolean;
  tolerance: number;
  fixturePath?: string;
  baselinePath?: string;
  updateBaselinePath?: string;
}

export interface RunCommandDeps {
  /** Build the LLM client for a real run. Injected in tests with a scripted model. */
  buildClient?: (model: string) => LlmClient;
}

export interface RunCommandResult {
  report: EvalReport;
  gate?: GateResult;
  /** True only when --gate was passed AND a regression was found (the bin exits non-zero). */
  gateFailed: boolean;
}

export function parseRunFlags(args: string[]): RunCommandFlags {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string" },
      fixture: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      baseline: { type: "string" },
      "update-baseline": { type: "string" },
      gate: { type: "boolean", default: false },
      tolerance: { type: "string" },
    },
    strict: true,
  });

  const model = values.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("--model is required");
  }
  const tolerance = values.tolerance === undefined ? 0.05 : Number(values.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("--tolerance must be a non-negative number");
  }

  const flags: RunCommandFlags = {
    model,
    json: Boolean(values.json),
    dryRun: Boolean(values["dry-run"]),
    gate: Boolean(values.gate),
    tolerance,
  };
  if (typeof values.fixture === "string") flags.fixturePath = values.fixture;
  if (typeof values.baseline === "string") flags.baselinePath = values.baseline;
  if (typeof values["update-baseline"] === "string") {
    flags.updateBaselinePath = values["update-baseline"];
  }
  return flags;
}

function loadFixture(path: string | undefined): IntakeFixtureEntry[] {
  if (path === undefined) return loadSeedFixture();
  return IntakeFixtureFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function buildRemoteClient(model: string): LlmClient {
  const endpoint = process.env[ENV_ENDPOINT];
  const token = process.env[ENV_TOKEN];
  if (!endpoint || !token) {
    throw new Error(`A real run requires ${ENV_ENDPOINT} and ${ENV_TOKEN} environment variables.`);
  }
  const config: LlmClientConfig = { endpoint, token, model };
  return createGroomingLlmClient(config);
}

export async function runEvalCommand(
  args: string[],
  deps: RunCommandDeps = {},
): Promise<RunCommandResult> {
  const flags = parseRunFlags(args);
  const fixture = loadFixture(flags.fixturePath);

  if (flags.dryRun) {
    // Validate the fixture parses and the real-run env is configured, without
    // calling any model.
    buildRemoteClient(flags.model);
    process.stdout.write(
      `intake-eval: dry-run OK — ${fixture.length} fixtures, env configured for ${flags.model}\n`,
    );
    return { report: emptyReport(), gateFailed: false };
  }

  const llmClient = (deps.buildClient ?? buildRemoteClient)(flags.model);
  const report = await runIntakeEval({ fixture, llmClient });

  if (flags.updateBaselinePath) {
    writeFileSync(
      flags.updateBaselinePath,
      `${JSON.stringify(baselineFromReport(report), null, 2)}\n`,
    );
    process.stdout.write(`intake-eval: wrote baseline → ${flags.updateBaselinePath}\n`);
  }

  let gate: GateResult | undefined;
  if (flags.baselinePath) {
    const baseline = BaselineSchema.parse(JSON.parse(readFileSync(flags.baselinePath, "utf8")));
    gate = compareToBaseline(report, baseline, flags.tolerance);
  }

  process.stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatSummary(report));
  if (gate) process.stdout.write(formatGate(gate));

  const gateFailed = Boolean(flags.gate && gate && !gate.passed);
  return gate ? { report, gate, gateFailed } : { report, gateFailed };
}

function pct(value: number | null): string {
  return value === null ? "  n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatSummary(report: EvalReport): string {
  const lines = [
    `Samples: ${report.sample_size}   Parse errors: ${report.parse_error_count}`,
    "",
    `  filing_accuracy        ${pct(report.filing_accuracy)}`,
    `  decision_band_accuracy ${pct(report.decision_band_accuracy)}`,
    `  no_clobber_rate        ${pct(report.no_clobber_rate)}`,
    `  contradiction_recall   ${pct(report.contradiction_recall)}`,
    `  entity_resolution      ${pct(report.entity_resolution)}`,
    "",
    "By scenario (action / decision correct):",
  ];
  for (const [scenario, b] of Object.entries(report.by_scenario)) {
    lines.push(
      `  ${scenario.padEnd(4)} ${b.action_correct}/${b.total}   ${b.decision_correct}/${b.total}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatGate(gate: GateResult): string {
  if (gate.passed) return `\nGate: PASS (tolerance ${gate.tolerance})\n`;
  const lines = [`\nGate: FAIL (tolerance ${gate.tolerance})`];
  for (const r of gate.regressions) {
    lines.push(
      `  ${r.metric.padEnd(22)} ${(r.baseline * 100).toFixed(1)}% → ${(r.observed * 100).toFixed(1)}% (${(r.delta * 100).toFixed(1)}%)`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function emptyReport(): EvalReport {
  return {
    sample_size: 0,
    filing_accuracy: 0,
    decision_band_accuracy: 0,
    no_clobber_rate: null,
    contradiction_recall: null,
    entity_resolution: null,
    parse_error_count: 0,
    by_scenario: {},
    samples: [],
  };
}
