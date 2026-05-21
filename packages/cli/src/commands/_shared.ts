// Shared command shape + the small lifecycle helper used by
// checkpoint/pause/end (T5.2).
//
// Each `commands/*.ts` exports a `Command` — a function with a fixed
// signature so `runtime.ts` can dispatch from a verb-name map without
// caring about per-verb signatures. Shared helpers (the lifecycle
// machinery and a `requireSession` narrower) live here rather than
// being copy-pasted across files.

import type { LibrarianStore } from "@librarian/core";
import { formatSessionLifecycle } from "@librarian/mcp-server";
import { type FlagMap, callerAgent, collectArray, readSummary } from "../parse-flags.js";

export interface CliResult {
  stdout: string;
  exitCode: number;
}

export type Command = (store: LibrarianStore, positionals: string[], flags: FlagMap) => CliResult;

export type LifecycleVerb = "checkpoint" | "pause" | "end";

// The session-lifecycle store methods return `{ session: Session | null }`
// because the SQL projection could theoretically miss a row. In
// practice every CLI path throws on a missing session before the
// trailing getSession() (see packages/core/src/store/session-store.ts),
// so a null here surfaces a genuine projection bug worth seeing.
export function requireSession<T>(result: { session: T | null }, headline: string): T {
  if (!result.session) throw new Error(`${headline} (no session row returned)`);
  return result.session;
}

export function runLifecycle(
  store: LibrarianStore,
  verb: LifecycleVerb,
  sessionId: string | undefined,
  flags: FlagMap,
): CliResult {
  if (!sessionId) {
    return { stdout: `Usage: the-librarian sessions ${verb} <session_id>`, exitCode: 1 };
  }
  const summary = readSummary(flags);
  // S1.1: end accepts a missing summary as the "abandonment" path.
  // checkpoint / pause still require it because they exist purely to
  // capture state.
  if (summary == null && verb !== "end") {
    return {
      stdout: `Provide --summary "<text>" or --summary-file <path> for ${verb}.`,
      exitCode: 1,
    };
  }
  const input = {
    agent_id: callerAgent(flags),
    admin: flags.admin === true,
    session_id: sessionId,
    summary: summary ?? "",
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
