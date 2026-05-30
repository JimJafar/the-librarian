// `the-librarian backup [--out <dir>] [--keep <n>]` — write a restorable snapshot
// bundle, then prune the local bundle dir to the newest `--keep` (default: the
// configured retention, or 14).

import { type LibrarianStore, createBackup, pruneLocal, readBackupConfig } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

export function backupCommand(
  store: LibrarianStore,
  _positionals: string[],
  flags: FlagMap,
): CliResult {
  const destDir = typeof flags.out === "string" && flags.out ? flags.out : process.cwd();

  const keepFlag = typeof flags.keep === "string" ? Number(flags.keep) : NaN;
  const keep =
    Number.isInteger(keepFlag) && keepFlag >= 1 ? keepFlag : readBackupConfig(store).retentionKeep;

  const { dir, manifest } = createBackup(store, { destDir });
  const pruned = pruneLocal(destDir, keep);

  const prunedNote = pruned.length ? ` Pruned ${pruned.length} old bundle(s) (keep ${keep}).` : "";
  return {
    stdout: `Backup written to ${dir} (${manifest.files.length} files, schema v${manifest.schema_version}).${prunedNote}`,
    exitCode: 0,
  };
}
