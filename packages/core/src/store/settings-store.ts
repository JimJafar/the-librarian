// Admin settings / secret store (memory-curator spec §7.1).
//
// A SQLite-authoritative key-value store for operator-managed admin config —
// notably the curator's LLM connection. Secret values (the LLM token) are
// encrypted at rest with AES-256-GCM via secret-crypto and require the master
// key (env `LIBRARIAN_SECRET_KEY`, injected as `secretKey`) to read or write;
// plain values do not. `listSettings` returns metadata only, so a secret value
// can never leak through the listing surface.
//
// When no master key is configured, secret operations throw — callers treat
// that as "secrets unavailable" (e.g. curation stays off) rather than storing
// a token in plaintext.

import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../constants.js";
import { decryptSecret, encryptSecret } from "../secret-crypto.js";
import type { SettingMeta, SettingsStore } from "./settings-types.js";

// Re-exported from the old path so existing importers don't change (PR-1).
export type { SettingMeta, SettingsStore } from "./settings-types.js";

interface SettingRow {
  key: string;
  value: string;
  is_secret: number;
  updated_at: string;
}

export function createSettingsStore(deps: {
  db: DatabaseSync;
  secretKey?: Buffer | null;
}): SettingsStore {
  const { db, secretKey } = deps;

  function requireKey(): Buffer {
    if (!secretKey) {
      throw new Error("a master key is required for secret settings (set LIBRARIAN_SECRET_KEY)");
    }
    return secretKey;
  }

  function setSetting(key: string, value: string, options: { secret?: boolean } = {}): void {
    const secret = options.secret === true;
    const stored = secret ? encryptSecret(value, requireKey()) : value;
    db.prepare(
      `INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         is_secret = excluded.is_secret, updated_at = excluded.updated_at`,
    ).run(key, stored, secret ? 1 : 0, nowIso());
  }

  function getSetting(key: string): string | null {
    const row = db
      .prepare("SELECT key, value, is_secret, updated_at FROM settings WHERE key = ?")
      .get(key) as SettingRow | undefined;
    if (!row) return null;
    return row.is_secret ? decryptSecret(row.value, requireKey()) : row.value;
  }

  function deleteSetting(key: string): void {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  function listSettings(): SettingMeta[] {
    const rows = db
      .prepare("SELECT key, is_secret, updated_at FROM settings ORDER BY key")
      .all() as Array<{ key: string; is_secret: number; updated_at: string }>;
    return rows.map((row) => ({
      key: row.key,
      is_secret: row.is_secret === 1,
      updated_at: row.updated_at,
    }));
  }

  return { setSetting, getSetting, deleteSetting, listSettings };
}
