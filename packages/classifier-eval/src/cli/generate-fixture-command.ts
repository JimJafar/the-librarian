// `classifier-eval generate-fixture` subcommand — wires the §4.7
// pipeline to real `createCuratorLlmClient` instances driven by a
// JSON config + environment-variable secrets.
//
// Single-shot operator command: never run in CI. Token references go
// via `token_env`, not literal strings, so a config file can be
// committed (e.g. to operator docs) without leaking secrets.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  LlmClientError,
  createCuratorLlmClient,
  type LlmClient,
  type LlmClientConfig,
} from "@librarian/core";
import { runFixtureGenerator } from "../generate/pipeline.js";
import type { PipelineClients } from "../generate/pipeline.js";
import { PipelineConfigSchema, type GraderConfig, type PipelineConfig } from "../generate/types.js";

const DEFAULT_TARGET = 900;
const DEFAULT_BOUNDARY_RATIO = 0.4;
const DEFAULT_CANDIDATES_PER_BATCH = 100;
const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_MAX_CALLS = 8000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GenerateFixtureFlags {
  configPath: string;
  outputPath: string;
  target: number;
  boundaryRatio: number;
  candidatesPerBatch: number;
  maxIterations: number;
  maxCalls: number;
  dryRun: boolean;
  verbose: boolean;
}

export function parseGenerateFixtureFlags(args: string[]): GenerateFixtureFlags {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      output: { type: "string" },
      target: { type: "string" },
      "boundary-ratio": { type: "string" },
      "candidates-per-batch": { type: "string" },
      "max-iterations": { type: "string" },
      "max-calls": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (typeof values.config !== "string" || values.config.length === 0) {
    throw new Error("--config <path> is required (graders + generator JSON config)");
  }
  if (typeof values.output !== "string" || values.output.length === 0) {
    throw new Error("--output <path> is required (where to write public-v1.json)");
  }
  return {
    configPath: values.config,
    outputPath: values.output,
    target: positiveInt(values.target, DEFAULT_TARGET, "--target"),
    boundaryRatio: fraction(values["boundary-ratio"], DEFAULT_BOUNDARY_RATIO, "--boundary-ratio"),
    candidatesPerBatch: positiveInt(
      values["candidates-per-batch"],
      DEFAULT_CANDIDATES_PER_BATCH,
      "--candidates-per-batch",
    ),
    maxIterations: positiveInt(
      values["max-iterations"],
      DEFAULT_MAX_ITERATIONS,
      "--max-iterations",
    ),
    maxCalls: positiveInt(values["max-calls"], DEFAULT_MAX_CALLS, "--max-calls"),
    dryRun: Boolean(values["dry-run"]),
    verbose: Boolean(values.verbose),
  };
}

export async function generateFixtureCommand(args: string[]): Promise<void> {
  const flags = parseGenerateFixtureFlags(args);
  const config = loadConfig(flags.configPath);
  const tokens = resolveTokens(config);

  if (flags.dryRun) {
    process.stderr.write(
      [
        "generate-fixture: dry-run",
        `  generator: ${config.generator.name} @ ${config.generator.endpoint} (model=${config.generator.model})`,
        ...config.graders.map((g) => `  grader: ${g.name} @ ${g.endpoint} (model=${g.model})`),
        `  target=${flags.target} boundary_ratio=${flags.boundaryRatio}`,
        `  candidates_per_batch=${flags.candidatesPerBatch} max_iterations=${flags.maxIterations} max_calls=${flags.maxCalls}`,
        `  output: ${flags.outputPath}`,
        "  (token resolution OK; no API calls made)",
        "",
      ].join("\n"),
    );
    return;
  }

  const clients = buildClients(config, tokens);
  const pipelineOpts: Parameters<typeof runFixtureGenerator>[1] = {
    config,
    targets: { total: flags.target, boundaryRatio: flags.boundaryRatio },
    budget: { maxCalls: flags.maxCalls },
    candidatesPerBatch: flags.candidatesPerBatch,
    maxIterations: flags.maxIterations,
  };
  if (flags.verbose) {
    pipelineOpts.log = (entry) => {
      process.stderr.write(`[generate-fixture] ${JSON.stringify(entry)}\n`);
    };
  }
  const result = await runFixtureGenerator(clients, pipelineOpts);

  writeFileSync(flags.outputPath, `${JSON.stringify(result.fixture, null, 2)}\n`);
  process.stderr.write(
    `[generate-fixture] wrote ${result.fixture.length} entries to ${flags.outputPath} ` +
      `(${result.apiCalls} API calls, ${result.iterations} iterations)\n`,
  );
}

function loadConfig(path: string): PipelineConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to read config at ${path}: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  return PipelineConfigSchema.parse(raw);
}

function resolveTokens(config: PipelineConfig): Map<string, string> {
  const out = new Map<string, string>();
  const refs = [config.generator, ...config.graders];
  for (const ref of refs) {
    const token = process.env[ref.token_env];
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(
        `env var ${ref.token_env} (for ${ref.name}) is empty or unset — refusing to start`,
      );
    }
    out.set(ref.token_env, token);
  }
  return out;
}

function buildClients(config: PipelineConfig, tokens: Map<string, string>): PipelineClients {
  const generatorClient = clientFor(config.generator, tokens);
  const graderClients = config.graders.map((g) => clientFor(g, tokens));
  return {
    async generate(prompt) {
      const completion = await generatorClient.complete({
        messages: [{ role: "user", content: prompt }],
        // The generator returns JSON in the body of its reply; we
        // explicitly request the JSON-mode response_format so models
        // that support it (GPT-4o, Claude) don't wrap the array in
        // markdown fences. The parser tolerates either shape.
        jsonResponse: true,
        temperature: 0.7,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      return completion.content;
    },
    async grade(graderIndex, prompt) {
      const client = graderClients[graderIndex];
      if (!client) throw new Error(`grader index out of range: ${graderIndex}`);
      try {
        const completion = await client.complete({
          messages: [{ role: "user", content: prompt }],
          jsonResponse: true,
          temperature: 0,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
        return completion.content;
      } catch (err) {
        // Surface as empty text — `parseVerdict` will return null,
        // which the consensus filter treats as `grader_failed`. We
        // deliberately don't echo the error message (could carry a
        // bearer token via a custom transport).
        void (err instanceof LlmClientError);
        return "";
      }
    },
  };
}

function clientFor(spec: GraderConfig, tokens: Map<string, string>): LlmClient {
  const token = tokens.get(spec.token_env);
  if (!token) throw new Error(`unresolved token for ${spec.name}`);
  const cfg: LlmClientConfig = {
    endpoint: spec.endpoint,
    token,
    model: spec.model,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  return createCuratorLlmClient(cfg);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got ${value})`);
  }
  return n;
}

function fraction(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be a number in [0, 1] (got ${value})`);
  }
  return n;
}
