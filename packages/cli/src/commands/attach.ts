import { formatSessionLifecycle } from "@librarian/mcp-server";
import { callerAgent, flagString } from "../parse-flags.js";
import { type Command, requireSession } from "./_shared.js";

export const attach: Command = (store, positionals, flags) => {
  const sessionId = positionals[0];
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
};
