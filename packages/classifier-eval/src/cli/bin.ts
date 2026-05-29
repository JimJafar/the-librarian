#!/usr/bin/env node
// classifier-eval CLI entry — wraps `runEval()` for shell + cron use.
// The dashboard uses the in-process API directly; this bin exists for
// scripting and ad-hoc operator runs (spec §4.6).

import { parseArgs } from "node:util";
import { generateFixtureCommand } from "./generate-fixture-command.js";
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
      await runEvalCommand(process.argv.slice(3));
      return;
    }
    case "generate-fixture": {
      await generateFixtureCommand(process.argv.slice(3));
      return;
    }
    case "replay": {
      process.stderr.write(
        `classifier-eval: subcommand "replay" not yet implemented — see ` +
          `docs/specs/done/023-classifier-implementation-spec.md §4.6.\n`,
      );
      process.exit(2);
      return;
    }
    case undefined:
    case "help":
    case "--help": {
      printHelp();
      return;
    }
    default: {
      process.stderr.write(`classifier-eval: unknown subcommand "${sub}"\n`);
      printHelp();
      process.exit(2);
    }
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "classifier-eval — operator-driven classifier evaluation",
      "",
      "Subcommands:",
      "  run                Run an evaluation against the configured classifier",
      "  generate-fixture   Build a §4.7 public consensus fixture (one-shot)",
      "  replay             (not yet implemented)",
      "",
      "Usage:",
      "  classifier-eval run --provider remote --model gpt-4o-mini --sample 10 --category boundary",
      "  classifier-eval generate-fixture --config graders.json --output fixtures/public-v1.json",
      "",
      "Options for `run`:",
      "  --provider remote         Provider to test (defaults to remote)",
      "  --model <id>              Model identifier (required)",
      "  --sample <n>              Sample size; defaults to 10",
      "  --category <all|straight|boundary>  Category filter; defaults to all",
      "  --fixture <path>          Path to fixture JSON; defaults to bundled seed-v1",
      "  --json                    Print the full report JSON to stdout (default: summary)",
      "",
      "Options for `generate-fixture`:",
      "  --config <path>           JSON file declaring generator + 3 graders (required)",
      "  --output <path>           Where to write the fixture JSON (required)",
      "  --target <n>              Total fixture size; defaults to 900",
      "  --boundary-ratio <f>      Fraction of total that's boundary; defaults to 0.4",
      "  --candidates-per-batch <n>  Defaults to 100",
      "  --max-iterations <n>      Defaults to 12",
      "  --max-calls <n>           Hard cap on LLM calls; defaults to 8000",
      "  --dry-run                 Validate config + token env vars without calling APIs",
      "  --verbose                 Emit per-iteration progress JSON to stderr",
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `classifier-eval: ${err instanceof Error ? err.message : "unknown error"}\n`,
  );
  process.exit(1);
});
