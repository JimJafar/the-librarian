import { formatSessionDetail } from "@librarian/mcp-server";
import type { Command } from "./_shared.js";

export const show: Command = (store, positionals, flags) => {
  const sessionId = positionals[0];
  if (!sessionId) return { stdout: "Usage: the-librarian sessions show <session_id>", exitCode: 1 };
  const session = store.getSession(sessionId);
  if (!session) return { stdout: `No session found for id ${sessionId}.`, exitCode: 2 };
  if (flags.json) return { stdout: JSON.stringify(session, null, 2), exitCode: 0 };
  return { stdout: formatSessionDetail(session), exitCode: 0 };
};
