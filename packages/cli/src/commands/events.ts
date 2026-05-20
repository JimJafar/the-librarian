import { formatSessionEvents } from "@librarian/mcp-server";
import { flagString, parseNumber } from "../parse-flags.js";
import type { Command } from "./_shared.js";

export const events: Command = (store, positionals, flags) => {
  const sessionId = positionals[0];
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
};
