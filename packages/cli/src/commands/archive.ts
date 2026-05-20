import { formatSessionLifecycle } from "@librarian/mcp-server";
import { callerAgent, flagString } from "../parse-flags.js";
import { type Command, requireSession } from "./_shared.js";

export const archive: Command = (store, positionals, flags) => {
  const sessionId = positionals[0];
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
};
