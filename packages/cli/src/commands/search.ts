import { formatSessionSearch } from "@librarian/mcp-server";
import { callerAgent, flagString, parseNumber } from "../parse-flags.js";
import type { Command } from "./_shared.js";

export const search: Command = (store, positionals, flags) => {
  const query = positionals[0];
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
};
