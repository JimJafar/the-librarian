// CLI runtime — pure function over a `LibrarianStore`.
//
// `runCli(argv, store)` returns `{ stdout, exitCode }` so the bin
// entry can shape it into a real process exit and tests can assert
// against the captured output without spawning a subprocess. T5.2
// will split each verb into its own file under `commands/`; for
// now the dispatch lives here so the surface stays mechanical and
// the runtime stays close to the legacy JS implementation.

import type { LibrarianStore } from "@librarian/core";
import {
  formatSessionDetail,
  formatSessionEvents,
  formatSessionLifecycle,
  formatSessionList,
  formatSessionSearch,
  formatSessionStart,
} from "@librarian/mcp-server";
import {
  type FlagMap,
  callerAgent,
  collectArray,
  flagString,
  parseFlags,
  parseNumber,
  readSummary,
} from "./parse-flags.js";

export interface CliResult {
  stdout: string;
  exitCode: number;
}

type LifecycleVerb = "checkpoint" | "pause" | "end";

// The session-lifecycle store methods return `{ session: Session | null }`
// because the underlying SQL projection could theoretically miss a row.
// In practice each method (see packages/core/src/store/session-store.ts:
// archiveSession / restoreSession / deleteSession etc.) throws on a
// missing session before the trailing getSession() runs, so a null
// here surfaces a genuine projection bug rather than an expected
// "session not found" state. Throwing keeps the formatter signatures
// honest (they require a non-null session).
function requireSession<T>(result: { session: T | null }, headline: string): T {
  if (!result.session) throw new Error(`${headline} (no session row returned)`);
  return result.session;
}

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

  const { positionals, flags } = parseFlags(rest);
  const firstArg = positionals[0];

  try {
    if (verb === "start") return cmdSessionsStart(store, flags);
    if (verb === "list") return cmdSessionsList(store, flags);
    if (verb === "show") return cmdSessionsShow(store, firstArg, flags);
    if (verb === "checkpoint") return cmdSessionsLifecycle(store, "checkpoint", firstArg, flags);
    if (verb === "pause") return cmdSessionsLifecycle(store, "pause", firstArg, flags);
    if (verb === "end") return cmdSessionsLifecycle(store, "end", firstArg, flags);
    if (verb === "attach") return cmdSessionsAttach(store, firstArg, flags);
    if (verb === "continue") return cmdSessionsContinue(store, firstArg, flags);
    if (verb === "archive") return cmdSessionsArchive(store, firstArg, flags);
    if (verb === "restore") return cmdSessionsRestore(store, firstArg, flags);
    if (verb === "delete") return cmdSessionsDelete(store, firstArg, flags);
    if (verb === "search") return cmdSessionsSearch(store, firstArg, flags);
    if (verb === "events") return cmdSessionsEvents(store, firstArg, flags);
    if (verb === "help" || verb === "--help") return { stdout: sessionsUsage(), exitCode: 0 };
  } catch (error) {
    return { stdout: `Error: ${(error as Error).message}`, exitCode: 1 };
  }
  return { stdout: `Unknown sessions verb: ${verb}\n\n${sessionsUsage()}`, exitCode: 1 };
}

function cmdSessionsStart(store: LibrarianStore, flags: FlagMap): CliResult {
  const visibility = flags.private ? "agent_private" : flagString(flags.visibility) || "common";
  const result = store.startSession({
    agent_id: callerAgent(flags),
    title: flagString(flags.title),
    project_key: flagString(flags.project),
    harness: flagString(flags.harness),
    source_ref: flagString(flags["source-ref"]),
    cwd: flagString(flags.cwd),
    capture_mode: flagString(flags["capture-mode"]),
    visibility,
    start_summary: flagString(flags["start-summary"]),
    tags: collectArray(flags.tag),
    next_steps: collectArray(flags["next-step"]),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return {
    stdout: formatSessionStart(requireSession(result, "Failed to start session")),
    exitCode: 0,
  };
}

function cmdSessionsList(store: LibrarianStore, flags: FlagMap): CliResult {
  const result = store.listSessions({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    project_key: flagString(flags.project),
    harness: flagString(flags.harness),
    cwd: flagString(flags.cwd),
    source_ref: flagString(flags["source-ref"]),
    status: collectArray(flags.status),
    include_archived: flags["include-archived"] === true,
    include_deleted: flags["include-deleted"] === true,
    limit: parseNumber(flags.limit),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: formatSessionList(result), exitCode: 0 };
}

function cmdSessionsShow(
  store: LibrarianStore,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) return { stdout: "Usage: the-librarian sessions show <session_id>", exitCode: 1 };
  const session = store.getSession(sessionId);
  if (!session) return { stdout: `No session found for id ${sessionId}.`, exitCode: 2 };
  if (flags.json) return { stdout: JSON.stringify(session, null, 2), exitCode: 0 };
  return { stdout: formatSessionDetail(session), exitCode: 0 };
}

function cmdSessionsLifecycle(
  store: LibrarianStore,
  verb: LifecycleVerb,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: `Usage: the-librarian sessions ${verb} <session_id>`, exitCode: 1 };
  }
  const summary = readSummary(flags);
  if (summary == null) {
    return {
      stdout: `Provide --summary "<text>" or --summary-file <path> for ${verb}.`,
      exitCode: 1,
    };
  }
  const input = {
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    summary,
    decisions: collectArray(flags.decision),
    files_touched: collectArray(flags.file),
    commands_run: collectArray(flags.command),
    open_questions: collectArray(flags.question),
    next_steps: collectArray(flags["next-step"]),
  };
  const method =
    verb === "checkpoint"
      ? store.checkpointSession
      : verb === "pause"
        ? store.pauseSession
        : store.endSession;
  const result = method(input);
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  const headline =
    verb === "checkpoint"
      ? "Checkpoint recorded."
      : verb === "pause"
        ? "Session paused."
        : "Session ended.";
  return {
    stdout: formatSessionLifecycle(requireSession(result, `Failed to ${verb} session`), headline),
    exitCode: 0,
  };
}

function cmdSessionsAttach(
  store: LibrarianStore,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions attach <session_id>", exitCode: 1 };
  }
  const result = store.attachSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    harness: flagString(flags.harness),
    source_ref: flagString(flags["source-ref"]),
    cwd: flagString(flags.cwd),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  const attached = requireSession(result, "Failed to attach session");
  return {
    stdout: formatSessionLifecycle(
      attached,
      `Attached to ${attached.current_harness || "(unspecified harness)"}.`,
    ),
    exitCode: 0,
  };
}

function cmdSessionsContinue(
  store: LibrarianStore,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions continue <session_id>", exitCode: 1 };
  }
  const attach = flags.attach !== false;
  const result = store.continueSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    target_harness: flagString(flags["target-harness"]),
    target_source_ref: flagString(flags["target-source-ref"]),
    target_cwd: flagString(flags["target-cwd"]),
    attach,
    format: flagString(flags.format),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: result.text, exitCode: 0 };
}

function cmdSessionsArchive(
  store: LibrarianStore,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions archive <session_id>", exitCode: 1 };
  }
  const result = store.archiveSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    reason: flagString(flags.reason),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return {
    stdout: formatSessionLifecycle(
      requireSession(result, "Failed to archive session"),
      "Session archived.",
    ),
    exitCode: 0,
  };
}

function cmdSessionsRestore(
  store: LibrarianStore,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions restore <session_id>", exitCode: 1 };
  }
  const result = store.restoreSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  const restored = requireSession(result, "Failed to restore session");
  return {
    stdout: formatSessionLifecycle(restored, `Session restored to ${restored.status}.`),
    exitCode: 0,
  };
}

function cmdSessionsDelete(
  store: LibrarianStore,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions delete <session_id>", exitCode: 1 };
  }
  const result = store.deleteSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    reason: flagString(flags.reason),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return {
    stdout: formatSessionLifecycle(
      requireSession(result, "Failed to delete session"),
      "Session deleted.",
    ),
    exitCode: 0,
  };
}

function cmdSessionsSearch(
  store: LibrarianStore,
  query: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!query) return { stdout: "Usage: the-librarian sessions search <query>", exitCode: 1 };
  const result = store.searchSessions({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    query,
    project_key: flagString(flags.project),
    include_archived: flags["include-archived"] === true,
    include_deleted: flags["include-deleted"] === true,
    limit: parseNumber(flags.limit),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: formatSessionSearch(result), exitCode: 0 };
}

function cmdSessionsEvents(
  store: LibrarianStore,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions events <session_id>", exitCode: 1 };
  }
  const session = store.getSession(sessionId);
  if (!session) return { stdout: `No session found for id ${sessionId}.`, exitCode: 2 };
  const result = store.listSessionEvents({
    session_id: sessionId,
    type: flagString(flags.type),
    limit: parseNumber(flags.limit),
    offset: parseNumber(flags.offset),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: formatSessionEvents(result, session), exitCode: 0 };
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

function usage(): string {
  return [
    "Usage: the-librarian <command>",
    "",
    "Commands:",
    "  rebuild                       Replay events.jsonl and sessions.jsonl into the SQLite projection",
    "  seed                          Seed sample memories (no-op if any exist)",
    "  sessions <verb>               Manage Librarian sessions (see 'sessions help')",
  ].join("\n");
}

function sessionsUsage(): string {
  return [
    "Usage: the-librarian sessions <verb> [args] [flags]",
    "",
    "Verbs:",
    "  start                         Start a new session",
    "  list                          List resumable sessions",
    "  show <session_id>             Show a single session in full",
    "  checkpoint <session_id>       Update rolling_summary (use --summary or --summary-file)",
    "  pause <session_id>            Mark paused with a summary",
    "  end <session_id>              End the session with end_summary",
    "  attach <session_id>           Record attachment to the caller's harness/source",
    "  continue <session_id>         Generate a handover package; default attaches",
    "  archive <session_id>          Hide from default lists",
    "  restore <session_id>          Restore an archived or deleted session",
    "  delete <session_id>           Soft-delete (owner-or-admin only)",
    "  search <query>                Full-text search across session events",
    "  events <session_id>           List per-session event stream",
    "",
    "Common flags:",
    "  --agent <id>                  Caller agent id (default: $LIBRARIAN_AGENT_ID or 'cli')",
    "  --admin                       Elevate to admin role (allows cross-agent delete/restore)",
    "  --project <key>               Scope to a project",
    "  --harness <name>              Caller harness identifier",
    "  --cwd <path>                  Caller working directory",
    "  --source-ref <ref>            Caller source reference (e.g. discord:channel:.../thread:...)",
    "  --json                        Emit JSON instead of prose",
    "  --format <name>               continue: prose|markdown|claude|codex|opencode|hermes|pi",
    "  --summary-file <path>         checkpoint/pause/end: read summary from a file",
    "  --no-attach                   continue: skip attachment (preview only)",
  ].join("\n");
}
