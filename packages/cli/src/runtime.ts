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

import { SYSTEM_ACTOR_IDS, type LibrarianStore } from "@librarian/core";
import type { CliResult, Command } from "./commands/_shared.js";
import { authUsage, authVerbs } from "./commands/auth.js";
import { backupCommand } from "./commands/backup.js";
import { exportCommand } from "./commands/export.js";
import { handoffVerbs, sessionVerbs } from "./commands/index.js";
import { restoreCommand } from "./commands/restore.js";
import { parseFlags } from "./parse-flags.js";

export type { CliResult } from "./commands/_shared.js";

// Top-level commands that take flags (unlike the bare rebuild/seed).
const topLevelCommands: Record<string, Command> = {
  backup: backupCommand,
  restore: restoreCommand,
  export: exportCommand,
};

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
  const topLevel = topLevelCommands[command];
  if (topLevel) {
    const { positionals, flags } = parseFlags(rest);
    return topLevel(store, positionals, flags);
  }
  if (command === "sessions") return runSessionsCommand(rest, store);
  if (command === "handoffs") return runHandoffsCommand(rest, store);
  if (command === "auth") return runAuthCommand(rest, store);
  return { stdout: `Unknown command: ${command}\n\n${usage()}`, exitCode: 1 };
}

function runAuthCommand(args: string[], store: LibrarianStore): CliResult {
  const [verb, ...rest] = args;
  if (!verb) return { stdout: authUsage(), exitCode: 1 };
  if (verb === "help" || verb === "--help") return { stdout: authUsage(), exitCode: 0 };

  const handler = authVerbs[verb];
  if (!handler) {
    return { stdout: `Unknown auth verb: ${verb}\n\n${authUsage()}`, exitCode: 1 };
  }

  const { positionals, flags } = parseFlags(rest);
  try {
    return handler(store, positionals, flags);
  } catch (error) {
    return { stdout: `Error: ${(error as Error).message}`, exitCode: 1 };
  }
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

function runHandoffsCommand(args: string[], store: LibrarianStore): CliResult {
  const [verb, ...rest] = args;
  if (!verb) return { stdout: handoffsUsage(), exitCode: 1 };
  if (verb === "help" || verb === "--help") return { stdout: handoffsUsage(), exitCode: 0 };

  const handler = handoffVerbs[verb];
  if (!handler) {
    return { stdout: `Unknown handoffs verb: ${verb}\n\n${handoffsUsage()}`, exitCode: 1 };
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
  // Bootstrap memories are placed by a system process, not an interactive
  // agent — attribute them to the reserved `system-migration` actor (§6) so
  // they don't masquerade as a bare `system` id near the system-* namespace.
  store.createMemory({
    agent_id: SYSTEM_ACTOR_IDS.migration,
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
    agent_id: SYSTEM_ACTOR_IDS.migration,
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
    "  backup [--out <dir>]          Write a restorable snapshot bundle",
    "  restore --from <dir> --force  Restore a snapshot bundle into the data dir (destructive)",
    "  export [--format ndjson|json] Dump memories + sessions to stdout",
    "  sessions <verb>               Manage Librarian sessions (see 'sessions help')",
    "  handoffs <verb>               Inspect cross-harness handoffs (see 'handoffs help')",
    "  auth <verb>                   Recover dashboard auth (see 'auth help')",
  ].join("\n");
}

export function handoffsUsage(): string {
  return [
    "Usage: the-librarian handoffs <verb> [args] [flags]",
    "",
    "Verbs:",
    "  list                          List handoffs (default: unclaimed in the current domain)",
    "  show <handoff_id>             Show a single handoff (including its document)",
    "  purge <handoff_id>            Admin-only — hard-delete a handoff row",
    "",
    "Common flags:",
    "  --project <key>               Filter by project_key",
    "  --cwd <path>                  Filter by cwd",
    "  --harness <name>              Filter by created_in_harness",
    "  --domain <name>               Scope to a domain (default: general)",
    "  --limit <n>                   list: max rows (default 20, max 100)",
    "  --include-claimed             list: include already-claimed handoffs (default: hide)",
    "  --admin                       purge: required",
    "  --json                        Emit JSON instead of prose",
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
