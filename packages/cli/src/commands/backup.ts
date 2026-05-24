// `the-librarian backup [--out <dir>]` — write a restorable snapshot bundle.

import { type LibrarianStore, createBackup } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

export function backupCommand(
  store: LibrarianStore,
  _positionals: string[],
  flags: FlagMap,
): CliResult {
  const destDir = typeof flags.out === "string" && flags.out ? flags.out : process.cwd();
  const { dir, manifest } = createBackup(store, { destDir });
  return {
    stdout: `Backup written to ${dir} (${manifest.files.length} files, schema v${manifest.schema_version}).`,
    exitCode: 0,
  };
}
