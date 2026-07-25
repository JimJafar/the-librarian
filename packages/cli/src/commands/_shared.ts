// Shared command-shape types kept after sessions-rethink PR 7 (the
// session-lifecycle helpers that used to live here are gone).

import type { LibrarianStore } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";

export interface CliResult {
  stdout: string;
  exitCode: number;
}

/**
 * A command may be synchronous or async (spec 073 T1). The dispatcher awaits
 * either, so every command that predates the async runtime keeps its plain
 * `CliResult` return and needed no change.
 */
export type Command = (
  store: LibrarianStore,
  positionals: string[],
  flags: FlagMap,
) => CliResult | Promise<CliResult>;
