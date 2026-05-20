import { formatSessionStart } from "@librarian/mcp-server";
import { callerAgent, collectArray, flagString } from "../parse-flags.js";
import { type Command, requireSession } from "./_shared.js";

export const start: Command = (store, _positionals, flags) => {
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
};
