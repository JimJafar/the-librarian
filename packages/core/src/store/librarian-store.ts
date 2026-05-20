import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJsonl } from "./jsonl.js";
import { type MemoryStore, createMemoryStore } from "./memory-store.js";
import { initSchema, rebuildMemoryIndex, rebuildSessionIndex } from "./projection.js";
import { type SessionStore, createSessionStore } from "./session-store.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

export interface LibrarianStoreOptions {
  dataDir?: string;
}

// The interface declaration merges the memory + session surfaces onto the
// class so callers see `store.createMemory(...)` etc. at the type level.
// At runtime the constructor copies those methods over from the factory
// outputs via Object.assign, so the merged shape is real, not just typed.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface LibrarianStore extends MemoryStore, SessionStore {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class LibrarianStore {
  dataDir: string;
  eventsPath: string;
  sessionsPath: string;
  dbPath: string;
  snapshotPath: string;
  db: DatabaseSync;

  constructor(options: LibrarianStoreOptions = {}) {
    this.dataDir = options.dataDir || process.env.LIBRARIAN_DATA_DIR || DEFAULT_DATA_DIR;
    this.eventsPath = path.join(this.dataDir, "events.jsonl");
    this.sessionsPath = path.join(this.dataDir, "sessions.jsonl");
    this.dbPath = path.join(this.dataDir, "librarian.sqlite");
    this.snapshotPath = path.join(this.dataDir, "memories.md");
    this.ensureFiles();
    this.db = new DatabaseSync(this.dbPath);
    initSchema(this.db);
    this.rebuildIndex();
    const memoryStore = createMemoryStore({
      db: this.db,
      eventsPath: this.eventsPath,
      rebuildMemoryIndex: () => this._rebuildMemoryIndex(),
    });
    const sessionStore = createSessionStore({
      db: this.db,
      sessionsPath: this.sessionsPath,
      createMemory: (input) => memoryStore.createMemory(input),
    });
    Object.assign(this, memoryStore, sessionStore);
  }

  ensureFiles(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.eventsPath)) fs.writeFileSync(this.eventsPath, "", "utf8");
    if (!fs.existsSync(this.sessionsPath)) fs.writeFileSync(this.sessionsPath, "", "utf8");
  }

  close(): void {
    this.db?.close();
  }

  readEvents(): Record<string, unknown>[] {
    return readJsonl(this.eventsPath);
  }

  readSessionEvents(): Record<string, unknown>[] {
    return readJsonl(this.sessionsPath);
  }

  rebuildIndex(): void {
    this._rebuildMemoryIndex();
    this._rebuildSessionIndex();
  }

  _rebuildMemoryIndex(): void {
    rebuildMemoryIndex({
      db: this.db,
      eventsPath: this.eventsPath,
      snapshotPath: this.snapshotPath,
    });
  }

  _rebuildSessionIndex(): void {
    rebuildSessionIndex(this.db, this.sessionsPath);
  }
}
