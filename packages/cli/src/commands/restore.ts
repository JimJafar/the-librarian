import { formatSessionLifecycle } from "@librarian/mcp-server";
import { callerAgent } from "../parse-flags.js";
import { type Command, requireSession } from "./_shared.js";

export const restore: Command = (store, positionals, flags) => {
  const sessionId = positionals[0];
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
    stdout: formatSessionLifecycle(
      restored,
      `Session restored to ${restored.status || "(unknown status)"}.`,
    ),
    exitCode: 0,
  };
};
