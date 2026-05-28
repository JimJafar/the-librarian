import { flagString, parseNumber } from "../parse-flags.js";
import type { Command } from "./_shared.js";

const DEFAULT_DOMAIN = "general";

export const handoffsList: Command = (store, _positionals, flags) => {
  const limit = parseNumber(flags.limit);
  const result = store.handoffs.list(
    {
      project_key: flagString(flags.project),
      cwd: flagString(flags.cwd),
      harness: flagString(flags.harness),
      ...(limit !== undefined ? { limit } : {}),
    },
    {
      domain: flagString(flags.domain) ?? DEFAULT_DOMAIN,
      includeClaimed: flags["include-claimed"] === true,
    },
  );
  if (flags.json) return { stdout: JSON.stringify(result, null, 2), exitCode: 0 };
  if (result.length === 0) return { stdout: "No handoffs.", exitCode: 0 };
  const lines = result.map(
    (row) => `${row.handoff_id}  ${row.created_at}  ${row.created_in_harness ?? "?"}  ${row.title}`,
  );
  return { stdout: lines.join("\n"), exitCode: 0 };
};
