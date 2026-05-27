// `classifier-eval run` subcommand. Parses flags, constructs the
// classifier from environment + config (mirroring the mcp-server's
// wiring), runs the eval, and prints the report.
//
// Wiring note: the production `local` provider requires
// `node-llama-cpp` to be installed and a downloaded GGUF. The CLI
// gates on `--provider remote` for portable use; `--provider local`
// is supported but requires the same prerequisites as the mcp-server
// wiring (see plan Section 4d for the production startup path).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createClassifier,
  createWorkerInferenceClient,
  type Classifier,
  type ProviderConfig,
} from "@librarian/classifier";
import { createCuratorLlmClient, type LlmClientConfig } from "@librarian/core";
import { FixtureFileSchema, type FixtureEntry } from "../fixture.js";
import { runEval, loadSeedFixture, type EvalReport } from "../index.js";

const ENV_REMOTE_ENDPOINT = "LIBRARIAN_CLASSIFIER_REMOTE_ENDPOINT";
const ENV_REMOTE_TOKEN = "LIBRARIAN_CLASSIFIER_REMOTE_TOKEN";

export interface RunCommandFlags {
  provider: "remote" | "local";
  model: string;
  sample: number;
  category: "all" | "straight" | "boundary";
  fixturePath?: string;
  json: boolean;
}

export function parseRunFlags(args: string[]): RunCommandFlags {
  const { values } = parseArgs({
    args,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      sample: { type: "string" },
      category: { type: "string" },
      fixture: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const provider = values.provider;
  const model = values.model;
  if (provider !== "remote" && provider !== "local") {
    throw new Error("--provider must be one of: remote, local");
  }
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("--model is required");
  }
  const category = values.category ?? "all";
  if (category !== "all" && category !== "straight" && category !== "boundary") {
    throw new Error("--category must be one of: all, straight, boundary");
  }
  const sample = Number(values.sample ?? "10");
  if (!Number.isFinite(sample) || sample <= 0) {
    throw new Error("--sample must be a positive integer");
  }
  const flags: RunCommandFlags = {
    provider,
    model,
    sample,
    category,
    json: Boolean(values.json),
  };
  if (typeof values.fixture === "string") flags.fixturePath = values.fixture;
  return flags;
}

export async function runEvalCommand(args: string[]): Promise<void> {
  const flags = parseRunFlags(args);
  const fixture = loadFixture(flags.fixturePath);
  const classifier = buildClassifier(flags);
  const report = await runEval(classifier, {
    fixture,
    sample: flags.sample,
    category: flags.category,
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatSummary(report));
  }
}

function loadFixture(path: string | undefined): FixtureEntry[] {
  if (path === undefined) return loadSeedFixture();
  const raw = readFileSync(path, "utf8");
  return FixtureFileSchema.parse(JSON.parse(raw));
}

function buildClassifier(flags: RunCommandFlags): Classifier {
  if (flags.provider === "remote") {
    const endpoint = process.env[ENV_REMOTE_ENDPOINT];
    const token = process.env[ENV_REMOTE_TOKEN];
    if (!endpoint || !token) {
      throw new Error(
        `Remote provider requires ${ENV_REMOTE_ENDPOINT} and ${ENV_REMOTE_TOKEN} environment variables.`,
      );
    }
    const llmConfig: LlmClientConfig = {
      endpoint,
      token,
      model: flags.model,
    };
    const llm = createCuratorLlmClient(llmConfig);
    const providerConfig: ProviderConfig = { provider: "remote", modelId: flags.model };
    return createClassifier(providerConfig, { llm });
  }
  // local
  const providerConfig: ProviderConfig = { provider: "local", modelId: flags.model };
  return createClassifier(providerConfig, {
    inferenceFor: (cfg) => createWorkerInferenceClient(cfg),
  });
}

function formatSummary(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Eval run: ${report.run_id}`);
  lines.push(
    `Provider: ${report.provider}   Model: ${report.model}   Prompt: ${report.prompt_version}`,
  );
  lines.push(`Samples: ${report.sample_size}   Filter: ${report.filter}`);
  lines.push("");
  lines.push("Agreement:");
  lines.push(`  joint              ${(report.agreement.joint * 100).toFixed(1)}%`);
  lines.push(`  requires_approval  ${(report.agreement.requires_approval * 100).toFixed(1)}%`);
  lines.push(`  is_global          ${(report.agreement.is_global * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("Disagreement by category:");
  for (const [cat, stats] of Object.entries(report.disagreement_by_category)) {
    lines.push(`  ${cat.padEnd(10)} ${stats.misses}/${stats.total} miss`);
  }
  lines.push("");
  lines.push("Latency (ms):");
  lines.push(
    `  p50 ${report.latency_ms.p50}   p95 ${report.latency_ms.p95}   p99 ${report.latency_ms.p99}   max ${report.latency_ms.max}`,
  );
  const fallbacks = Object.entries(report.fallback_counts);
  if (fallbacks.length > 0) {
    lines.push("");
    lines.push("Fallbacks:");
    for (const [reason, count] of fallbacks) {
      lines.push(`  ${reason.padEnd(22)} ${count}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
