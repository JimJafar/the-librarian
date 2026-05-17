#!/usr/bin/env node
import { LibrarianStore } from "./store.js";
import {
  formatSessionDetail,
  formatSessionList,
  formatSessionStart
} from "./mcp.js";

export function runCli(argv, store) {
  const [command, ...rest] = argv;

  if (!command) {
    return { stdout: usage(), exitCode: 1 };
  }

  if (command === "help" || command === "--help" || command === "-h") {
    return { stdout: usage(), exitCode: 0 };
  }

  if (command === "rebuild") {
    store.rebuildIndex();
    return {
      stdout: `Rebuilt projection from ${store.eventsPath} and ${store.sessionsPath}`,
      exitCode: 0
    };
  }

  if (command === "seed") {
    seed(store);
    return {
      stdout: `Seeded sample proposal and operating memory in ${store.dataDir}`,
      exitCode: 0
    };
  }

  if (command === "sessions") {
    return runSessionsCommand(rest, store);
  }

  return { stdout: `Unknown command: ${command}\n\n${usage()}`, exitCode: 1 };
}

function runSessionsCommand(args, store) {
  const [verb, ...rest] = args;
  if (!verb) return { stdout: sessionsUsage(), exitCode: 1 };

  const { positionals, flags } = parseFlags(rest);

  if (verb === "start") return cmdSessionsStart(store, flags);
  if (verb === "list") return cmdSessionsList(store, flags);
  if (verb === "show") return cmdSessionsShow(store, positionals[0], flags);
  if (verb === "help" || verb === "--help") return { stdout: sessionsUsage(), exitCode: 0 };

  return { stdout: `Unknown sessions verb: ${verb}\n\n${sessionsUsage()}`, exitCode: 1 };
}

function cmdSessionsStart(store, flags) {
  const visibility = flags.private
    ? "agent_private"
    : flags.visibility || "common";
  const result = store.startSession({
    agent_id: callerAgent(flags),
    title: flags.title,
    project_key: flags.project,
    harness: flags.harness,
    source_ref: flags["source-ref"],
    cwd: flags.cwd,
    capture_mode: flags["capture-mode"],
    visibility,
    start_summary: flags["start-summary"],
    tags: collectArray(flags.tag),
    next_steps: collectArray(flags["next-step"])
  });

  if (flags.json) {
    return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  }
  return { stdout: formatSessionStart(result.session), exitCode: 0 };
}

function cmdSessionsList(store, flags) {
  const result = store.listSessions({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    project_key: flags.project,
    harness: flags.harness,
    cwd: flags.cwd,
    source_ref: flags["source-ref"],
    status: collectArray(flags.status),
    include_archived: flags["include-archived"] === true,
    include_deleted: flags["include-deleted"] === true,
    limit: parseNumber(flags.limit)
  });

  if (flags.json) {
    return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  }
  return { stdout: formatSessionList(result), exitCode: 0 };
}

function cmdSessionsShow(store, sessionId, flags) {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions show <session_id>", exitCode: 1 };
  }
  const session = store.getSession(sessionId);
  if (!session) {
    return { stdout: `No session found for id ${sessionId}.`, exitCode: 2 };
  }
  if (flags.json) {
    return { stdout: JSON.stringify(session, null, 2), exitCode: 0 };
  }
  return { stdout: formatSessionDetail(session), exitCode: 0 };
}

function callerAgent(flags) {
  return flags.agent || process.env.LIBRARIAN_AGENT_ID || "cli";
}

function collectArray(value) {
  if (value == null || value === true || value === false) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

function parseNumber(value) {
  if (value == null || value === true || value === false) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseFlags(args) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    if (arg.startsWith("--no-")) {
      flags[arg.slice("--no-".length)] = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
        flags[key] = true;
      } else {
        if (flags[key] === undefined) {
          flags[key] = next;
        } else if (Array.isArray(flags[key])) {
          flags[key].push(next);
        } else {
          flags[key] = [flags[key], next];
        }
        i += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

function usage() {
  return [
    "Usage: the-librarian <command>",
    "",
    "Commands:",
    "  rebuild                       Replay events.jsonl and sessions.jsonl into the SQLite projection",
    "  seed                          Seed sample memories (no-op if any exist)",
    "  sessions <verb>               Manage Librarian sessions (see 'sessions help')"
  ].join("\n");
}

function sessionsUsage() {
  return [
    "Usage: the-librarian sessions <verb> [args] [flags]",
    "",
    "Verbs:",
    "  start                         Start a new session",
    "  list                          List resumable sessions",
    "  show <session_id>             Show a single session in full",
    "",
    "Common flags:",
    "  --agent <id>                  Caller agent id (default: $LIBRARIAN_AGENT_ID or 'cli')",
    "  --project <key>               Scope to a project",
    "  --harness <name>              Caller harness identifier",
    "  --cwd <path>                  Caller working directory",
    "  --source-ref <ref>            Caller source reference (e.g. discord:channel:.../thread:...)",
    "  --json                        Emit JSON instead of prose"
  ].join("\n");
}

function seed(target) {
  const existing = target._listAll({});
  if (existing.length) return;

  target.createMemory({
    agent_id: "system",
    title: "The Librarian protects identity memory",
    body: "Identity and relationship memories should be proposed for review rather than written directly by agents.",
    category: "tools",
    visibility: "common",
    scope: "tool",
    priority: "high",
    confidence: "strong",
    tags: ["librarian", "policy"]
  });

  target.createMemory({
    agent_id: "system",
    title: "User identity context belongs in proposals first",
    body: "The user wants durable identity and relationship context preserved carefully, without agents silently rewriting it.",
    category: "identity",
    visibility: "common",
    scope: "global",
    priority: "core",
    confidence: "working",
    tags: ["identity", "protected"]
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const store = new LibrarianStore();
  try {
    const result = runCli(process.argv.slice(2), store);
    if (result.stdout) console.log(result.stdout);
    process.exitCode = result.exitCode || 0;
  } finally {
    store.close();
  }
}
