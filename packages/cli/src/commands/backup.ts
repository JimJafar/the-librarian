// `the-librarian backup` — push the memory vault to the configured GitHub backup
// remote (set the repo + token in the backup settings / dashboard). The vault is a
// git repo, so a backup is a `git push` of its current HEAD. Restore is `git clone`.

import { type InternalLibrarianStore, resolveBackupRemote } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

export function backupCommand(
  store: InternalLibrarianStore,
  _positionals: string[],
  _flags: FlagMap,
): CliResult {
  const remote = resolveBackupRemote(store);
  if (!remote) {
    return {
      stdout: "No backup remote configured — set the GitHub repo + token in the backup settings.",
      exitCode: 1,
    };
  }
  try {
    const commit = store.pushVaultBackup(remote.auth);
    return {
      stdout: `Pushed the vault to ${remote.repo}${commit ? ` (${commit.slice(0, 7)})` : ""}.`,
      exitCode: 0,
    };
  } catch (err) {
    // Push errors are already token-scrubbed at the push site.
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: `Backup failed: ${message}`, exitCode: 1 };
  }
}
