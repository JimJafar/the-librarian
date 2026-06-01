// JSON settings / secret store (plan 036 Phase 2). Settings (incl. the
// curator's encrypted LLM token) can't live in the git-pushed vault and
// aren't knowledge, so they move to a plain JSON file OUTSIDE the vault
// (decided 2026-06-01). The AES-256-GCM at-rest crypto is unchanged from the
// SQLite store — only persistence swaps to a file; the file holds ciphertext
// for secret values, never plaintext. Replaces the SQLite settings-store at
// the Phase-7 cutover.

import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../../constants.js";
import { decryptSecret, encryptSecret } from "../../secret-crypto.js";
import type { SettingMeta, SettingsStore } from "../settings-store.js";

interface SettingEntry {
  value: string;
  is_secret: boolean;
  updated_at: string;
}

export interface JsonSettingsStoreDeps {
  /** Sidecar file path, outside the git vault (e.g. `<data-dir>/settings.json`). */
  filePath: string;
  /** AES-256 master key for secret values; secret ops throw when absent. */
  secretKey?: Buffer | null;
}

export function createJsonSettingsStore(deps: JsonSettingsStoreDeps): SettingsStore {
  const { filePath, secretKey } = deps;

  function requireKey(): Buffer {
    if (!secretKey) {
      throw new Error("a master key is required for secret settings (set LIBRARIAN_SECRET_KEY)");
    }
    return secretKey;
  }

  function readAll(): Record<string, SettingEntry> {
    if (!fs.existsSync(filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, SettingEntry>) : {};
    } catch {
      return {};
    }
  }

  function writeAll(map: Record<string, SettingEntry>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Owner-only (0600): the file holds AES-GCM ciphertext for secrets, so a
    // world-readable copy would hand a local attacker the ciphertext for an
    // offline attack. `mode` applies on create; harmless on overwrite.
    fs.writeFileSync(filePath, `${JSON.stringify(map, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  function setSetting(key: string, value: string, options: { secret?: boolean } = {}): void {
    const secret = options.secret === true;
    const stored = secret ? encryptSecret(value, requireKey()) : value;
    const map = readAll();
    map[key] = { value: stored, is_secret: secret, updated_at: nowIso() };
    writeAll(map);
  }

  function getSetting(key: string): string | null {
    const entry = readAll()[key];
    if (!entry) return null;
    return entry.is_secret ? decryptSecret(entry.value, requireKey()) : entry.value;
  }

  function deleteSetting(key: string): void {
    const map = readAll();
    if (key in map) {
      delete map[key];
      writeAll(map);
    }
  }

  function listSettings(): SettingMeta[] {
    return Object.entries(readAll())
      .map(([key, entry]) => ({ key, is_secret: entry.is_secret, updated_at: entry.updated_at }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  return { setSetting, getSetting, deleteSetting, listSettings };
}
