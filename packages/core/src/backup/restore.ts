// Restore a backup bundle into a data dir (spec: persistence-backup-restore, B1).
//
// Verifies the manifest + every file's checksum BEFORE touching the data dir, then
// swaps each file in atomically (temp + rename). The store MUST be closed during a
// restore (the SQLite file is replaced). On the next store open, ensureSchema
// rebuilds the memory projection if the backup's schema_version is older; session
// state is SQLite-canonical, so a same-version restore is exact (a cross-version
// restore rebuilds memory from the ledger but may not reconstruct old session
// state — see the spec).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BACKUP_FORMAT_VERSION, BACKUP_MANIFEST, type BackupManifest } from "./backup.js";

export class BackupRestoreError extends Error {
  override readonly name = "BackupRestoreError";
}

export interface RestoreResult {
  dataDir: string;
  restored: string[];
  schemaVersion: number;
}

function isManifest(value: unknown): value is BackupManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.format_version !== "number" || !Array.isArray(m.files)) return false;
  return m.files.every(
    (f) =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as Record<string, unknown>).name === "string" &&
      typeof (f as Record<string, unknown>).sha256 === "string",
  );
}

// A manifest file name must be a plain basename that stays inside the data dir —
// reject path separators / `..` so a hostile manifest can't write outside it
// (arbitrary-file-write via restore).
function assertSafeName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split(/[\\/]/).includes("..") ||
    name === ".." ||
    path.isAbsolute(name) ||
    path.basename(name) !== name
  ) {
    throw new BackupRestoreError(`unsafe backup file name: ${JSON.stringify(name)}`);
  }
}

export function restoreBackup(backupDir: string, options: { dataDir: string }): RestoreResult {
  const manifestPath = path.join(backupDir, BACKUP_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new BackupRestoreError(`no ${BACKUP_MANIFEST} in ${backupDir}`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new BackupRestoreError(`${BACKUP_MANIFEST} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isManifest(manifest)) {
    throw new BackupRestoreError(`${BACKUP_MANIFEST} is structurally invalid`);
  }
  if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
    throw new BackupRestoreError(
      `unsupported backup format_version ${manifest.format_version} (expected ${BACKUP_FORMAT_VERSION})`,
    );
  }

  // Validate everything up front (safe names + presence + checksums) so a corrupt
  // or hostile backup never half-overwrites — or escapes — the data dir.
  for (const file of manifest.files) {
    assertSafeName(file.name);
    const src = path.join(backupDir, file.name);
    if (!fs.existsSync(src)) throw new BackupRestoreError(`backup file missing: ${file.name}`);
    const actual = createHash("sha256").update(fs.readFileSync(src)).digest("hex");
    if (actual !== file.sha256) {
      throw new BackupRestoreError(`checksum mismatch for ${file.name}`);
    }
  }

  fs.mkdirSync(options.dataDir, { recursive: true });
  const restored: string[] = [];
  for (const file of manifest.files) {
    const src = path.join(backupDir, file.name);
    const dest = path.join(options.dataDir, file.name);
    const tmp = `${dest}.restore-${process.pid}-${Date.now()}.tmp`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest); // atomic on the same filesystem
    restored.push(file.name);
  }
  return { dataDir: options.dataDir, restored, schemaVersion: manifest.schema_version };
}
