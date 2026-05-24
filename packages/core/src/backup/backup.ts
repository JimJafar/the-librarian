// Backup: a consistent, restorable snapshot of the whole store (spec:
// persistence-backup-restore, B1).
//
// The snapshot is a plain directory bundle (zero-dep, transparent to restore):
//   <dir>/librarian.sqlite        — VACUUM INTO copy (transactionally consistent
//                                    even on a live connection)
//   <dir>/events.jsonl            — memory ledger (append-only)
//   <dir>/session_events.jsonl    — session timeline ledger (append-only)
//   <dir>/sessions.legacy.jsonl   — pre-R3 anchor, only if present
//   <dir>/manifest.json           — format + schema version, file list + sha256
//
// The derived memories.md snapshot is intentionally NOT backed up — restore
// regenerates it from events.jsonl. The JSONL ledgers are append-only, so a copy
// taken in the same (quiescent) window is consistent with the SQLite snapshot.

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
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(options.destDir, `librarian-backup-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  // SQLite: a transactionally-consistent copy. VACUUM INTO refuses to overwrite,
  // so the fresh backup dir guarantees the dest doesn't exist.
  const dbDest = path.join(dir, "librarian.sqlite");
  store.db.exec(`VACUUM INTO '${dbDest.replace(/'/g, "''")}'`);

  const ledgers: { name: string; src: string }[] = [
    { name: "events.jsonl", src: store.eventsPath },
    { name: "session_events.jsonl", src: store.sessionsPath },
  ];
  if (fs.existsSync(store.sessionsLegacyPath)) {
    ledgers.push({ name: "sessions.legacy.jsonl", src: store.sessionsLegacyPath });
  }
  for (const ledger of ledgers) {
    fs.copyFileSync(ledger.src, path.join(dir, ledger.name));
  }

  const names = ["librarian.sqlite", ...ledgers.map((l) => l.name)];
  const manifest: BackupManifest = {
    format_version: BACKUP_FORMAT_VERSION,
    created_at: new Date().toISOString(),
    schema_version: getSchemaVersion(store.db),
    files: names.map((name) => {
      const abs = path.join(dir, name);
      return { name, sha256: sha256(abs), bytes: fs.statSync(abs).size };
    }),
  };
  fs.writeFileSync(path.join(dir, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest };
}
