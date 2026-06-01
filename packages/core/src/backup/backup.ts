// Backup: a consistent, restorable snapshot of the whole store (spec:
// persistence-backup-restore B1; automated-backups A1 added gzip).
//
// The snapshot is a directory bundle (zero-dep, transparent to restore). As of
// format_version 2 each data file is stored gzipped (`node:zlib`):
//   <dir>/librarian.sqlite.gz     — gzip of a VACUUM INTO copy (transactionally
//                                    consistent even on a live connection)
//   <dir>/events.jsonl.gz         — gzip of the memory ledger (append-only)
//   <dir>/memories.md.gz          — gzip of the derived snapshot, only if present
//   <dir>/manifest.json           — format + schema version, file list with the
//                                    stored (compressed) + uncompressed sha256/bytes
//
// `restore` reads format_version 1 (plain) bundles too — see restore.ts.
//
// Older bundles may also carry `session_events.jsonl` and
// `sessions.legacy.jsonl` from the retired session subsystem
// (sessions-rethink PR 7). The post-PR-7 backup path no longer
// produces them; the restore tolerates their presence in older
// bundles (`createLibrarianStore` renames them to
// `.predeprecation.bak` on next open).
//
// PRECONDITION: the caller should quiesce writes for the snapshot window. The
// store is synchronous and single-owner, so a backup taken between requests is
// point-in-time; VACUUM INTO is transactionally consistent regardless, and the
// JSONL ledgers are append-only, so the copies are consistent with the db snapshot.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { InternalLibrarianStore } from "../store/librarian-store.js";
import { getSchemaVersion } from "../store/projection.js";

export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_MANIFEST = "manifest.json";

export interface BackupFileEntry {
  /** Logical name = the restore target (and the bundle file name when uncompressed). */
  name: string;
  /** sha256 of the STORED bytes — the gzipped object for v2, the raw file for v1. */
  sha256: string;
  /** Stored (on-disk) byte size. */
  bytes: number;
  /** Compression of the stored object. Absent ⇒ stored verbatim (legacy v1 bundles). */
  compression?: "gzip";
  /** sha256 of the decompressed content. Present when `compression` is set. */
  uncompressed_sha256?: string;
  /** Decompressed content byte size. Present when `compression` is set. */
  uncompressed_bytes?: number;
}

export interface BackupManifest {
  format_version: number;
  created_at: string;
  schema_version: number;
  files: BackupFileEntry[];
}

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function createBackup(
  store: InternalLibrarianStore,
  options: { destDir: string },
): BackupResult {
  const now = new Date();
  // A fresh dir per backup. Two backups in the same millisecond would otherwise
  // collide on the timestamped name (the second silently overwriting the first);
  // an incrementing suffix guarantees uniqueness and still sorts chronologically.
  const base = `librarian-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
  let dir = path.join(options.destDir, base);
  for (let suffix = 1; fs.existsSync(dir); suffix++) {
    dir = path.join(options.destDir, `${base}-${suffix}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  try {
    // SQLite: a transactionally-consistent copy via VACUUM INTO (refuses to
    // overwrite, so the fresh dir guarantees the dest is new), read back, then
    // gzip — this uncompressed temp is deleted and never ships in the bundle (the
    // shipped artifact is `librarian.sqlite.gz`).
    const dbTmp = path.join(dir, "librarian.sqlite.vacuum-tmp");
    store.db.exec(`VACUUM INTO '${dbTmp.replace(/'/g, "''")}'`);
    const dbPlain = fs.readFileSync(dbTmp);
    fs.rmSync(dbTmp);

    const sources: { name: string; data: Buffer }[] = [
      { name: "librarian.sqlite", data: dbPlain },
      { name: "events.jsonl", data: fs.readFileSync(store.eventsPath) },
    ];
    if (fs.existsSync(store.snapshotPath)) {
      sources.push({ name: "memories.md", data: fs.readFileSync(store.snapshotPath) });
    }

    // Each data file is stored gzipped as `<name>.gz`. The manifest pins both the
    // stored (compressed) and the uncompressed sha256/bytes so restore can verify
    // the on-disk object AND the decompressed content.
    const files = sources.map(({ name, data }): BackupFileEntry => {
      const gz = gzipSync(data);
      fs.writeFileSync(path.join(dir, `${name}.gz`), gz);
      return {
        name,
        compression: "gzip",
        sha256: sha256(gz),
        bytes: gz.length,
        uncompressed_sha256: sha256(data),
        uncompressed_bytes: data.length,
      };
    });

    const manifest: BackupManifest = {
      format_version: BACKUP_FORMAT_VERSION,
      created_at: now.toISOString(),
      schema_version: getSchemaVersion(store.db),
      files,
    };
    fs.writeFileSync(path.join(dir, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, manifest };
  } catch (err) {
    // Never leave a half-written bundle that could later be mistaken for a good one.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
