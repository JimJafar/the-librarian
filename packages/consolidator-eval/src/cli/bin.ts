#!/usr/bin/env node
// consolidator-eval CLI entry. Wraps `runConsolidatorEval()` for operator runs
// against a real model + the regression gate. The dashboard / tests use the
// in-process API directly; this bin exists for ad-hoc runs and CI gating.

import { parseArgs } from "node:util";
import { runEvalCommand } from "./run-command.js";

async function main(): Promise<void> {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
  });

  const sub = positionals[0];
  switch (sub) {
    case "run": {
      const result = await runEvalCommand(process.argv.slice(3));
      if (result.gateFailed) process.exit(1);
      return;
    }
    case undefined:
    case "help":
    case "--help": {
      printHelp();
      return;
    }
    default: {
      process.stderr.write(`consolidator-eval: unknown subcommand "${sub}"\n`);
      printHelp();
      process.exit(2);
    }
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "consolidator-eval — operator-driven consolidator evaluation",
      "",
      "Subcommands:",
      "  run    Run the eval over a fixture against the configured model",
      "",
      "Usage:",
      "  consolidator-eval run --model gpt-4o-mini",
      "  consolidator-eval run --model gpt-4o-mini --update-baseline fixtures/baseline.json",
      "  consolidator-eval run --model gpt-4o-mini --baseline fixtures/baseline.json --gate",
      "",
      "Options for `run`:",
      "  --model <id>              Model identifier (required)",
      "  --fixture <path>          Fixture JSON; defaults to the bundled seed-v1",
      "  --json                    Print the full report JSON (default: summary)",
      "  --dry-run                 Validate the fixture + env without calling a model",
      "  --baseline <path>         Compare the run's metrics against this baseline",
      "  --update-baseline <path>  Freeze this run's metrics as the baseline (no gate)",
      "  --gate                    Exit non-zero if any metric regresses past --tolerance",
      "  --tolerance <f>           Allowed drop before a regression; defaults to 0.05",
      "",
      "Environment (for a real run):",
      "  LIBRARIAN_CONSOLIDATOR_EVAL_ENDPOINT   OpenAI-compatible base URL",
      "  LIBRARIAN_CONSOLIDATOR_EVAL_TOKEN      Bearer token",
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `consolidator-eval: ${err instanceof Error ? err.message : "unknown error"}\n`,
  );
  process.exit(1);
});
