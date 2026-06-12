// `the-librarian migrate-data-dir` — the one-shot data-dir migration (rethink
// T26, spec §10). Mutates only what the rethink retired (runs-file rename,
// frontmatter sweep, retired settings keys) and NEVER deletes data: legacy
// artifacts come back as an "archivable" list with sizes, and anything unsafe
// to touch (unreadable secrets, stuck lock rows) is a "needs the operator"
// line. Idempotent — a second run prints "Nothing to do".
//
// The server boot runs the same checks warn-only; this command performs them.

import fs from "node:fs";
import path from "node:path";
import {
  type LibrarianStore,
  type MigrateDataDirReport,
  formatByteSize,
  migrateDataDir,
  resolveSecretKey,
} from "@librarian/core";
import { type FlagMap, flagString } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

export function migrateDataDirCommand(
  store: LibrarianStore,
  _positionals: string[],
  flags: FlagMap,
): CliResult {
  const dataDir = flagString(flags["data-dir"]) ?? store.dataDir;
  try {
    const legacyIntakeEnv = process.env.LIBRARIAN_CONSOLIDATOR;
    const report = migrateDataDir({
      dataDir,
      secretKey: resolveMigrationSecretKey(dataDir),
      ...(legacyIntakeEnv !== undefined ? { legacyIntakeEnv } : {}),
    });
    return { stdout: formatReport(report), exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: `Migration failed: ${message}`, exitCode: 1 };
  }
}

// The boot's D0 resolution order (env, then ${dataDir}/secret.key) WITHOUT the
// generate step — a migration must never mint credentials. Fail-soft to null:
// secret settings then read as unavailable, and the migration reports (instead
// of removes) anything it couldn't read.
function resolveMigrationSecretKey(dataDir: string): Buffer | null {
  const raw = process.env.LIBRARIAN_SECRET_KEY ?? tryReadFile(path.join(dataDir, "secret.key"));
  if (raw === null || raw.trim() === "") return null;
  try {
    return resolveSecretKey(raw);
  } catch {
    return null;
  }
}

function tryReadFile(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function formatReport(report: MigrateDataDirReport): string {
  const lines: string[] = [`Data-dir migration — ${report.dataDir}`, ""];

  lines.push("Changes made:");
  if (report.changes.length === 0) {
    lines.push("  (nothing to do — the data dir is already migrated)");
  } else {
    for (const change of report.changes) lines.push(`  - ${change}`);
  }

  lines.push("", "Archivable legacy artifacts (left in place — never deleted):");
  if (report.artifacts.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const artifact of report.artifacts) {
      lines.push(`  - ${artifact.path} (${formatByteSize(artifact.bytes)}) — ${artifact.note}`);
    }
  }

  if (report.operatorNotes.length > 0) {
    lines.push("", "Needs the operator:");
    for (const note of report.operatorNotes) lines.push(`  - ${note}`);
  }

  return lines.join("\n");
}
