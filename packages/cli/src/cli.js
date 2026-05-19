import fs from "node:fs";
import {
  formatSessionDetail,
  formatSessionEvents,
  formatSessionLifecycle,
  formatSessionList,
  formatSessionSearch,
  formatSessionStart,
} from "@librarian/mcp-server";

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

  if (command === "sessions") {
    return runSessionsCommand(rest, store);
  }

  return { stdout: `Unknown command: ${command}\n\n${usage()}`, exitCode: 1 };
}

function runSessionsCommand(args, store) {
  const [verb, ...rest] = args;
  if (!verb) return { stdout: sessionsUsage(), exitCode: 1 };

  const { positionals, flags } = parseFlags(rest);

  try {
    if (verb === "start") return cmdSessionsStart(store, flags);
    if (verb === "list") return cmdSessionsList(store, flags);
    if (verb === "show") return cmdSessionsShow(store, positionals[0], flags);
    if (verb === "checkpoint")
      return cmdSessionsLifecycle(store, "checkpoint", positionals[0], flags);
    if (verb === "pause") return cmdSessionsLifecycle(store, "pause", positionals[0], flags);
    if (verb === "end") return cmdSessionsLifecycle(store, "end", positionals[0], flags);
    if (verb === "attach") return cmdSessionsAttach(store, positionals[0], flags);
    if (verb === "continue") return cmdSessionsContinue(store, positionals[0], flags);
    if (verb === "archive") return cmdSessionsArchive(store, positionals[0], flags);
    if (verb === "restore") return cmdSessionsRestore(store, positionals[0], flags);
    if (verb === "delete") return cmdSessionsDelete(store, positionals[0], flags);
    if (verb === "search") return cmdSessionsSearch(store, positionals[0], flags);
    if (verb === "events") return cmdSessionsEvents(store, positionals[0], flags);
    if (verb === "help" || verb === "--help") return { stdout: sessionsUsage(), exitCode: 0 };
  } catch (error) {
    return { stdout: `Error: ${error.message}`, exitCode: 1 };
  }

  return { stdout: `Unknown sessions verb: ${verb}\n\n${sessionsUsage()}`, exitCode: 1 };
}

function cmdSessionsStart(store, flags) {
  const visibility = flags.private ? "agent_private" : flags.visibility || "common";
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
    next_steps: collectArray(flags["next-step"]),
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
    limit: parseNumber(flags.limit),
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

function cmdSessionsLifecycle(store, verb, sessionId, flags) {
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
      ? store.checkpointSession.bind(store)
      : verb === "pause"
        ? store.pauseSession.bind(store)
        : store.endSession.bind(store);
  const result = method(input);
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  const headline =
    verb === "checkpoint"
      ? "Checkpoint recorded."
      : verb === "pause"
        ? "Session paused."
        : "Session ended.";
  return { stdout: formatSessionLifecycle(result.session, headline), exitCode: 0 };
}

function cmdSessionsAttach(store, sessionId, flags) {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions attach <session_id>", exitCode: 1 };
  }
  const result = store.attachSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    harness: flags.harness,
    source_ref: flags["source-ref"],
    cwd: flags.cwd,
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return {
    stdout: formatSessionLifecycle(
      result.session,
      `Attached to ${result.session.current_harness || "(unspecified harness)"}.`,
    ),
    exitCode: 0,
  };
}

function cmdSessionsContinue(store, sessionId, flags) {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions continue <session_id>", exitCode: 1 };
  }
  const attach = flags.attach !== false;
  const result = store.continueSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    target_harness: flags["target-harness"],
    target_source_ref: flags["target-source-ref"],
    target_cwd: flags["target-cwd"],
    attach,
    format: flags.format,
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: result.text, exitCode: 0 };
}

function cmdSessionsArchive(store, sessionId, flags) {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions archive <session_id>", exitCode: 1 };
  }
  const result = store.archiveSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    reason: flags.reason,
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: formatSessionLifecycle(result.session, "Session archived."), exitCode: 0 };
}

function cmdSessionsRestore(store, sessionId, flags) {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions restore <session_id>", exitCode: 1 };
  }
  const result = store.restoreSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return {
    stdout: formatSessionLifecycle(result.session, `Session restored to ${result.session.status}.`),
    exitCode: 0,
  };
}

function cmdSessionsDelete(store, sessionId, flags) {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions delete <session_id>", exitCode: 1 };
  }
  const result = store.deleteSession({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    reason: flags.reason,
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: formatSessionLifecycle(result.session, "Session deleted."), exitCode: 0 };
}

function cmdSessionsSearch(store, query, flags) {
  if (!query) {
    return { stdout: "Usage: the-librarian sessions search <query>", exitCode: 1 };
  }
  const result = store.searchSessions({
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    query,
    project_key: flags.project,
    include_archived: flags["include-archived"] === true,
    include_deleted: flags["include-deleted"] === true,
    limit: parseNumber(flags.limit),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: formatSessionSearch(result), exitCode: 0 };
}

function cmdSessionsEvents(store, sessionId, flags) {
  if (!sessionId) {
    return { stdout: "Usage: the-librarian sessions events <session_id>", exitCode: 1 };
  }
  const session = store.getSession(sessionId);
  if (!session) {
    return { stdout: `No session found for id ${sessionId}.`, exitCode: 2 };
  }
  const result = store.listSessionEvents({
    session_id: sessionId,
    type: flags.type,
    limit: parseNumber(flags.limit),
    offset: parseNumber(flags.offset),
  });
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  return { stdout: formatSessionEvents(result, session), exitCode: 0 };
}

function readSummary(flags) {
  if (typeof flags.summary === "string") return flags.summary;
  const file = flags["summary-file"];
  if (typeof file === "string" && file.length) {
    return fs.readFileSync(file, "utf8").trimEnd();
  }
  return null;
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
    "  sessions <verb>               Manage Librarian sessions (see 'sessions help')",
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
    tags: ["librarian", "policy"],
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
    tags: ["identity", "protected"],
  });
}
