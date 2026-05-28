// Backup: a consistent, restorable snapshot of the whole store (spec:
// persistence-backup-restore, B1).
//
// The snapshot is a plain directory bundle (zero-dep, transparent to restore):
//   <dir>/librarian.sqlite        — VACUUM INTO copy (transactionally consistent
//                                    even on a live connection)
//   <dir>/events.jsonl            — memory ledger (append-only)
//   <dir>/memories.md             — derived snapshot, only if present
//   <dir>/manifest.json           — format + schema version, file list + sha256
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
import type { LibrarianStore } from "../store/librarian-store.js";
import { getSchemaVersion } from "../store/projection.js";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST = "manifest.json";

export interface BackupFileEntry {
  name: string;
  sha256: string;
  bytes: number;
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

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function createBackup(store: LibrarianStore, options: { destDir: string }): BackupResult {
  const now = new Date();
  const dir = path.join(
    options.destDir,
    `librarian-backup-${now.toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.mkdirSync(dir, { recursive: true });

  try {
    // SQLite: a transactionally-consistent copy. VACUUM INTO refuses to overwrite,
    // so the fresh backup dir guarantees the dest doesn't exist.
    const dbDest = path.join(dir, "librarian.sqlite");
    store.db.exec(`VACUUM INTO '${dbDest.replace(/'/g, "''")}'`);

    const copies: { name: string; src: string }[] = [
      { name: "events.jsonl", src: store.eventsPath },
    ];
    if (fs.existsSync(store.snapshotPath)) {
      copies.push({ name: "memories.md", src: store.snapshotPath });
    }
    for (const copy of copies) {
      fs.copyFileSync(copy.src, path.join(dir, copy.name));
    }

    const names = ["librarian.sqlite", ...copies.map((c) => c.name)];
    const manifest: BackupManifest = {
      format_version: BACKUP_FORMAT_VERSION,
      created_at: now.toISOString(),
      schema_version: getSchemaVersion(store.db),
      files: names.map((name) => {
        const abs = path.join(dir, name);
        return { name, sha256: sha256(abs), bytes: fs.statSync(abs).size };
      }),
    };
    fs.writeFileSync(path.join(dir, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, manifest };
  } catch (err) {
    // Never leave a half-written bundle that could later be mistaken for a good one.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
