// Restore a backup bundle into a data dir (spec: persistence-backup-restore B1;
// automated-backups A1 added gzip + back-compat).
//
// Validates the manifest, every stored file's checksum, and (for gzipped entries)
// the decompressed content's checksum BEFORE touching the data dir, then swaps each
// file in atomically (temp + rename). The store MUST be closed during a restore (the
// SQLite file is replaced). On the next store open, ensureSchema rebuilds the memory
// projection if the backup's schema_version is older.
//
// Both bundle formats restore: format_version 2 (gzipped, `<name>.gz`) and the
// legacy format_version 1 (plain files). The branch is per manifest entry, keyed on
// the `compression` field, so a v1 bundle on disk or in the cloud still restores.
//
// sessions-rethink PR 7 — older backups may carry `session_events.jsonl` and
// `sessions.legacy.jsonl` entries from the retired session subsystem. The
// restore tolerates them: the files are copied back like any other manifest
// entry, but the post-PR-7 store ignores them (and `createLibrarianStore`
// renames any leftover ledger to `.predeprecation.bak` on the next open).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { BACKUP_FORMAT_VERSION, BACKUP_MANIFEST, type BackupManifest } from "./backup.js";

// Formats restore knows how to read: the current gzipped format plus the legacy
// plain-file format (1).
const SUPPORTED_FORMAT_VERSIONS = new Set([1, BACKUP_FORMAT_VERSION]);

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

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
  if (!SUPPORTED_FORMAT_VERSIONS.has(manifest.format_version)) {
    throw new BackupRestoreError(
      `unsupported backup format_version ${manifest.format_version} (supported: ${[
        ...SUPPORTED_FORMAT_VERSIONS,
      ].join(", ")})`,
    );
  }

  // Phase 1 — validate + decode EVERYTHING before touching the data dir, so a
  // corrupt or hostile bundle never half-overwrites (or escapes) it: safe names,
  // the stored (compressed) checksum, then the decompressed content checksum.
  const prepared: { name: string; data: Buffer }[] = [];
  for (const file of manifest.files) {
    assertSafeName(file.name);
    const gzipped = file.compression === "gzip";
    const storedName = gzipped ? `${file.name}.gz` : file.name;
    const src = path.join(backupDir, storedName);
    if (!fs.existsSync(src)) throw new BackupRestoreError(`backup file missing: ${storedName}`);

    const stored = fs.readFileSync(src);
    if (sha256Hex(stored) !== file.sha256) {
      throw new BackupRestoreError(`checksum mismatch for ${storedName}`);
    }

    let data = stored;
    if (gzipped) {
      try {
        data = gunzipSync(stored);
      } catch (err) {
        throw new BackupRestoreError(
          `failed to decompress ${storedName}: ${(err as Error).message}`,
        );
      }
      if (file.uncompressed_sha256 && sha256Hex(data) !== file.uncompressed_sha256) {
        throw new BackupRestoreError(`decompressed checksum mismatch for ${file.name}`);
      }
    }
    prepared.push({ name: file.name, data });
  }

  // Phase 2 — swap each decoded file in atomically (temp + rename).
  fs.mkdirSync(options.dataDir, { recursive: true });
  const restored: string[] = [];
  for (const { name, data } of prepared) {
    const dest = path.join(options.dataDir, name);
    const tmp = `${dest}.restore-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest); // atomic on the same filesystem
    restored.push(name);
  }
  return { dataDir: options.dataDir, restored, schemaVersion: manifest.schema_version };
}
