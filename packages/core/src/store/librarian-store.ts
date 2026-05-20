import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJsonl } from "./jsonl.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import { ensureSchema, rebuildMemoryIndex, rebuildSessionIndex } from "./projection.js";
import { type SessionStore, createSessionStore } from "./session-store.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

export interface LibrarianStoreOptions {
  dataDir?: string;
}

export interface LibrarianStore extends MemoryStore, SessionStore {
  dataDir: string;
  eventsPath: string;
  sessionsPath: string;
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
  const sessionsPath = path.join(dataDir, "sessions.jsonl");
  const dbPath = path.join(dataDir, "librarian.sqlite");
  const snapshotPath = path.join(dataDir, "memories.md");

  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(eventsPath)) fs.writeFileSync(eventsPath, "", "utf8");
  if (!fs.existsSync(sessionsPath)) fs.writeFileSync(sessionsPath, "", "utf8");

  const db = new DatabaseSync(dbPath);
  ensureSchema(db, { eventsPath, sessionsPath, snapshotPath });

  function rebuildMemoryProjection(): void {
    rebuildMemoryIndex({ db, eventsPath, snapshotPath });
  }
  function rebuildIndex(): void {
    rebuildMemoryProjection();
    rebuildSessionIndex(db, sessionsPath);
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

  return {
    ...memoryStore,
    ...sessionStore,
    dataDir,
    eventsPath,
    sessionsPath,
    dbPath,
    snapshotPath,
    db,
    close: () => db.close(),
    readEvents: () => readJsonl(eventsPath),
    readSessionEvents: () => readJsonl(sessionsPath),
    rebuildIndex,
  };
}
