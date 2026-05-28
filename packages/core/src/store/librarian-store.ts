import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ConversationStateStore,
  createConversationStateStore,
} from "./conversation-state-store.js";
import { type CurationStore, createCurationStore } from "./curation-store.js";
import { type DomainsStore, createDomainsStore } from "./domains-store.js";
import { type HandoffStore, createHandoffStore } from "./handoff-store.js";
import { readJsonl } from "./jsonl.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import { ensureSchema, rebuildMemoryIndex } from "./projection.js";
import { type SettingsStore, createSettingsStore } from "./settings-store.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

/**
 * Resolve the data directory the store (and its sibling credential files) live in:
 * an explicit option wins, then `LIBRARIAN_DATA_DIR`, then `<cwd>/data`. Exported
 * so the boot path can place `secret.key`/`admin.token` in the exact same dir the
 * store will use, before the store (which needs the key) is constructed.
 */
export function resolveDataDir(dataDir?: string): string {
  return dataDir || process.env.LIBRARIAN_DATA_DIR || DEFAULT_DATA_DIR;
}

export interface LibrarianStoreOptions {
  dataDir?: string;
  /**
   * Master key for the admin secret-store (memory-curator §7.1). Resolved by
   * the caller from `LIBRARIAN_SECRET_KEY` via `resolveSecretKey`. When absent,
   * secret settings throw on access; plain settings still work.
   */
  secretKey?: Buffer | null;
}

export interface LibrarianStore extends MemoryStore, CurationStore, SettingsStore {
  convState: ConversationStateStore;
  domains: DomainsStore;
  handoffs: HandoffStore;
  dataDir: string;
  eventsPath: string;
  dbPath: string;
  snapshotPath: string;
  db: DatabaseSync;
  close(): void;
  readEvents(): Record<string, unknown>[];
  rebuildIndex(): void;
}

export function createLibrarianStore(options: LibrarianStoreOptions = {}): LibrarianStore {
  const dataDir = resolveDataDir(options.dataDir);
  const eventsPath = path.join(dataDir, "events.jsonl");
  const dbPath = path.join(dataDir, "librarian.sqlite");
  const snapshotPath = path.join(dataDir, "memories.md");

  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "", "utf8");

  // sessions-rethink PR 7 — rename any leftover session ledger files to
  // `.predeprecation.bak` so operators can see they've been retired. The
  // new build never reads or writes them; deletion is left to the
  // operator's choice.
  for (const stem of ["session_events.jsonl", "sessions.legacy.jsonl", "sessions.jsonl"]) {
    const src = path.join(dataDir, stem);
    if (!fs.existsSync(src)) continue;
    const bak = `${src}.predeprecation.bak`;
    try {
      fs.renameSync(src, bak);
    } catch {
      /* ignore — best-effort cleanup */
    }
  }

  const db = new DatabaseSync(dbPath);
  ensureSchema(db, { eventsPath, snapshotPath });

  function rebuildIndex(): void {
    rebuildMemoryIndex({ db, eventsPath, snapshotPath });
  }

  const memoryStore = createMemoryStore({
    db,
    eventsPath,
    rebuildMemoryIndex: rebuildIndex,
  });
  const curationStore = createCurationStore({ db });
  const settingsStore = createSettingsStore({ db, secretKey: options.secretKey ?? null });
  const convState = createConversationStateStore({ db });
  const domains = createDomainsStore({ db });
  const handoffs = createHandoffStore({ db });

  return {
    ...memoryStore,
    ...curationStore,
    ...settingsStore,
    convState,
    domains,
    handoffs,
    dataDir,
    eventsPath,
    dbPath,
    snapshotPath,
    db,
    close: () => db.close(),
    readEvents: () => readJsonl(eventsPath),
    rebuildIndex,
  };
}
