import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CurationStore, createCurationStore } from "./curation-store.js";
import { readJsonl } from "./jsonl.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import { ensureSchema, rebuildMemoryIndex, rebuildSessionIndex } from "./projection.js";
import { type SessionStore, createSessionStore } from "./session-store.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

export interface LibrarianStoreOptions {
  dataDir?: string;
}

export interface LibrarianStore extends MemoryStore, SessionStore, CurationStore {
  dataDir: string;
  eventsPath: string;
  // R3 — sessionsPath is the timeline ledger (post-R3, new file).
  // Legacy sessions.jsonl is preserved as sessions.legacy.jsonl for
  // pre-migration ledger replay and operator backups; sessionsLegacyPath
  // is the runtime handle for it.
  sessionsPath: string;
  sessionsLegacyPath: string;
  dbPath: string;
  snapshotPath: string;
  db: DatabaseSync;
  close(): void;
  readEvents(): Record<string, unknown>[];
  readSessionEvents(): Record<string, unknown>[];
  rebuildIndex(): void;
}

export function createLibrarianStore(options: LibrarianStoreOptions = {}): LibrarianStore {
  const dataDir = options.dataDir || process.env.LIBRARIAN_DATA_DIR || DEFAULT_DATA_DIR;
  const eventsPath = path.join(dataDir, "events.jsonl");
  // R3 — runtime writes timeline events to session_events.jsonl. State
  // transitions stop appearing in any JSONL (they live in SQLite +
  // session_state_changes). The pre-migration sessions.jsonl is renamed
  // by `scripts/migrate-sessions-to-authoritative-sqlite.mjs` to
  // sessions.legacy.jsonl and kept read-only as the historical anchor.
  const sessionsPath = path.join(dataDir, "session_events.jsonl");
  const sessionsLegacyPath = path.join(dataDir, "sessions.legacy.jsonl");
  // Fallback: if the operator hasn't run the migration yet, the old
  // `sessions.jsonl` may still be sitting in the data dir from a
  // pre-R3 install. Treat it as the legacy ledger for rebuild
  // purposes only (no writes ever go there post-R3).
  const preMigrationLegacyPath = path.join(dataDir, "sessions.jsonl");
  const dbPath = path.join(dataDir, "librarian.sqlite");
  const snapshotPath = path.join(dataDir, "memories.md");

  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "", "utf8");
  if (!fs.existsSync(sessionsPath)) fs.writeFileSync(sessionsPath, "", "utf8");

  const db = new DatabaseSync(dbPath);
  ensureSchema(db, {
    eventsPath,
    sessionsPath,
    sessionsLegacyPath: fs.existsSync(sessionsLegacyPath)
      ? sessionsLegacyPath
      : preMigrationLegacyPath,
    snapshotPath,
  });

  function rebuildMemoryProjection(): void {
    rebuildMemoryIndex({ db, eventsPath, snapshotPath });
  }
  function rebuildIndex(): void {
    rebuildMemoryProjection();
    rebuildSessionIndex(db, sessionsPath, {
      sessionsLegacyPath: fs.existsSync(sessionsLegacyPath)
        ? sessionsLegacyPath
        : preMigrationLegacyPath,
    });
  }

  const memoryStore = createMemoryStore({
    db,
    eventsPath,
    rebuildMemoryIndex: rebuildMemoryProjection,
  });
  const sessionStore = createSessionStore({
    db,
    sessionsPath,
    createMemory: (input) => memoryStore.createMemory(input),
  });
  const curationStore = createCurationStore({ db });

  return {
    ...memoryStore,
    ...sessionStore,
    ...curationStore,
    dataDir,
    eventsPath,
    sessionsPath,
    sessionsLegacyPath,
    dbPath,
    snapshotPath,
    db,
    close: () => db.close(),
    readEvents: () => readJsonl(eventsPath),
    readSessionEvents: () => readJsonl(sessionsPath),
    rebuildIndex,
  };
}
