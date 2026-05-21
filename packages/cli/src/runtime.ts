// CLI runtime — pure function over a `LibrarianStore`.
//
// `runCli(argv, store)` returns `{ stdout, exitCode }` so the bin
// entry can shape it into a real process exit and tests can assert
// against the captured output without spawning a subprocess.
//
// T5.2 split each session verb into its own file under `commands/`;
// this module dispatches `sessions <verb>` via the `sessionVerbs`
// map and keeps `rebuild` / `seed` (the two top-level commands)
// inline. Per-verb logic is now < 100 LOC per file.

import type { LibrarianStore } from "@librarian/core";
import type { CliResult } from "./commands/_shared.js";
import { sessionVerbs } from "./commands/index.js";
import { parseFlags } from "./parse-flags.js";

export type { CliResult } from "./commands/_shared.js";

export function runCli(argv: string[], store: LibrarianStore): CliResult {
  const [command, ...rest] = argv;

  if (!command) return { stdout: usage(), exitCode: 1 };
  if (command === "help" || command === "--help" || command === "-h") {
    return { stdout: usage(), exitCode: 0 };
  }
  if (command === "rebuild") {
    store.rebuildIndex();
    return {
      stdout: `Rebuilt projection from ${store.eventsPath} and ${store.sessionsPath}`,
      exitCode: 0,
    };
  }
  if (command === "seed") {
    seed(store);
    return {
      stdout: `Seeded sample proposal and operating memory in ${store.dataDir}`,
      exitCode: 0,
    };
  }
  if (command === "sessions") return runSessionsCommand(rest, store);
  return { stdout: `Unknown command: ${command}\n\n${usage()}`, exitCode: 1 };
}

function runSessionsCommand(args: string[], store: LibrarianStore): CliResult {
  const [verb, ...rest] = args;
  if (!verb) return { stdout: sessionsUsage(), exitCode: 1 };
  if (verb === "help" || verb === "--help") return { stdout: sessionsUsage(), exitCode: 0 };

  const handler = sessionVerbs[verb];
  if (!handler) {
    return { stdout: `Unknown sessions verb: ${verb}\n\n${sessionsUsage()}`, exitCode: 1 };
  }

  const { positionals, flags } = parseFlags(rest);
  try {
    return handler(store, positionals, flags);
  } catch (error) {
    return { stdout: `Error: ${(error as Error).message}`, exitCode: 1 };
  }
}

function seed(store: LibrarianStore): void {
  const existing = store.listAll({});
  if (existing.length) return;
  store.createMemory({
    agent_id: "system",
    title: "The Librarian protects identity memory",
    body: "Identity and relationship memories should be proposed for review rather than written directly by agents.",
    category: "tools",
    visibility: "common",
    scope: "tool",
    priority: "high",
    confidence: "strong",
    tags: ["librarian", "policy"],
  });
  store.createMemory({
    agent_id: "system",
    title: "User identity context belongs in proposals first",
    body: "The user wants durable identity and relationship context preserved carefully, without agents silently rewriting it.",
    category: "identity",
    visibility: "common",
    scope: "global",
    priority: "core",
    confidence: "working",
    tags: ["identity", "protected"],
  });
}

export function usage(): string {
  return [
    "Usage: the-librarian <command>",
    "",
    "Commands:",
    "  rebuild                       Replay events.jsonl and sessions.jsonl into the SQLite projection",
    "  seed                          Seed sample memories (no-op if any exist)",
    "  sessions <verb>               Manage Librarian sessions (see 'sessions help')",
  ].join("\n");
}

export function sessionsUsage(): string {
  return [
    "Usage: the-librarian sessions <verb> [args] [flags]",
    "",
    "Verbs:",
    "  start                         Start a new session",
    "  list                          List resumable sessions (active + paused; pass --include-ended for ended)",
    "  show <session_id>             Show a single session in full",
    "  checkpoint <session_id>       Update rolling_summary (use --summary or --summary-file)",
    "  pause <session_id>            Mark paused with a summary",
    "  end <session_id>              End the session (summary optional)",
    "  attach <session_id>           Record attachment to the caller's harness/source",
    "  continue <session_id>         Generate a handover package; default attaches (works on ended)",
    "  search <query>                Full-text search across session events",
    "  events <session_id>           List per-session event stream",
    "",
    "Common flags:",
    "  --agent <id>                  Caller agent id (default: $LIBRARIAN_AGENT_ID or 'cli')",
    "  --admin                       Elevate to admin role",
    "  --project <key>               Scope to a project",
    "  --harness <name>              Caller harness identifier",
    "  --cwd <path>                  Caller working directory",
    "  --source-ref <ref>            Caller source reference (e.g. discord:channel:.../thread:...)",
    "  --json                        Emit JSON instead of prose",
    "  --include-ended               list/search: include ended sessions in results",
    "  --format <name>               continue: prose|markdown|claude|codex|opencode|hermes|pi",
    "  --summary-file <path>         checkpoint/pause/end: read summary from a file",
    "  --no-attach                   continue: skip attachment (preview only)",
  ].join("\n");
}
