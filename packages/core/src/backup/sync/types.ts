// Object-storage abstraction for backup sync (spec: persistence-backup-restore,
// B3). Pluggable so S3-compatible is the first impl and GCS/others can drop in.
// Cloud sync is async, so it runs from the async server/dashboard (B4), not the
// synchronous CLI.

export interface BackupTarget {
  /** Store `data` at `name` (overwriting). */
  put(name: string, data: Buffer): Promise<void>;
  /** Fetch the bytes at `name`. Rejects if absent. */
  get(name: string): Promise<Buffer>;
  /** List object names, optionally filtered by a `prefix`. */
  list(prefix?: string): Promise<string[]>;
}
