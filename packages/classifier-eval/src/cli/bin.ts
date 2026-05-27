#!/usr/bin/env node
// classifier-eval CLI entry — wraps `runEval()` for shell + cron use.
// The dashboard uses the in-process API directly; this bin exists for
// scripting and ad-hoc operator runs (spec §4.6).

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
      await runEvalCommand(process.argv.slice(3));
      return;
    }
    case "replay":
    case "generate-fixture": {
      process.stderr.write(
        `classifier-eval: subcommand "${sub}" not yet implemented — see ` +
          `docs/specs/classifier-implementation-spec.md §4.6 + plan Task 4.10.\n`,
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
      "  replay             (not yet implemented)",
      "  generate-fixture   (not yet implemented)",
      "",
      "Usage:",
      "  classifier-eval run --provider remote --model gpt-4o-mini --sample 10 --category boundary",
      "",
      "Options for `run`:",
      "  --provider remote|local   Provider to test (required)",
      "  --model <id>              Model identifier (required)",
      "  --sample <n>              Sample size; defaults to 10",
      "  --category <all|straight|boundary>  Category filter; defaults to all",
      "  --fixture <path>          Path to fixture JSON; defaults to bundled seed-v1",
      "  --json                    Print the full report JSON to stdout (default: summary)",
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
