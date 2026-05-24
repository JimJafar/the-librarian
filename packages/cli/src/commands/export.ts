// `the-librarian export [--format ndjson|json]` — portable dump of memories +
// sessions (every status/visibility). Defaults to ndjson.

import { type LibrarianStore, exportData } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

export function exportCommand(
  store: LibrarianStore,
  _positionals: string[],
  flags: FlagMap,
): CliResult {
  const format = flags.format === "json" ? "json" : "ndjson";
  return { stdout: exportData(store, { format }), exitCode: 0 };
}
