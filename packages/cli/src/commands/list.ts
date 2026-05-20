import { formatSessionList } from "@librarian/mcp-server";
import { callerAgent, collectArray, flagString, parseNumber } from "../parse-flags.js";
import type { Command } from "./_shared.js";

export const list: Command = (store, _positionals, flags) => {
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
};
