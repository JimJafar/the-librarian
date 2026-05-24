// `the-librarian restore --from <backup-dir> --force` — restore a snapshot bundle.
//
// Destructive: it overwrites the data dir, so it requires --force. It closes the
// store first (the SQLite file is replaced) — restore is terminal, so the handle
// stays closed; the bin's own close is idempotent.

import { BackupRestoreError, type LibrarianStore, restoreBackup } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

export function restoreCommand(
  store: LibrarianStore,
  _positionals: string[],
  flags: FlagMap,
): CliResult {
  const from = typeof flags.from === "string" ? flags.from : "";
  if (!from) {
    return { stdout: "restore requires --from <backup-dir>.", exitCode: 1 };
  }
  if (flags.force !== true) {
    return {
      stdout: `restore OVERWRITES the data dir (${store.dataDir}). Re-run with --force once you're sure.`,
      exitCode: 1,
    };
  }

  store.close(); // release the SQLite handle before the file is replaced
  try {
    const result = restoreBackup(from, { dataDir: store.dataDir });
    return {
      stdout: `Restored ${result.restored.length} files to ${result.dataDir} (schema v${result.schemaVersion}). Restart the server.`,
      exitCode: 0,
    };
  } catch (err) {
    if (err instanceof BackupRestoreError) {
      return { stdout: `Restore failed: ${err.message}`, exitCode: 1 };
    }
    throw err;
  }
}
