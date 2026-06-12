// Shared command-shape types kept after sessions-rethink PR 7 (the
// session-lifecycle helpers that used to live here are gone).

import type { LibrarianStore } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";

export interface CliResult {
  stdout: string;
  exitCode: number;
}

export type Command = (store: LibrarianStore, positionals: string[], flags: FlagMap) => CliResult;
