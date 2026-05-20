import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createMemoryStore,
  createSessionStore,
  initSchema,
  readJsonl,
  rebuildMemoryIndex,
  rebuildSessionIndex,
} from "@librarian/core/store-internal";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

export class LibrarianStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.env.LIBRARIAN_DATA_DIR || DEFAULT_DATA_DIR;
    this.eventsPath = path.join(this.dataDir, "events.jsonl");
    this.sessionsPath = path.join(this.dataDir, "sessions.jsonl");
    this.dbPath = path.join(this.dataDir, "librarian.sqlite");
    this.snapshotPath = path.join(this.dataDir, "memories.md");
    this.ensureFiles();
    this.db = new DatabaseSync(this.dbPath);
    this.initDb();
    this.rebuildIndex();
    this._memoryStore = createMemoryStore({
      db: this.db,
      eventsPath: this.eventsPath,
      rebuildMemoryIndex: () => this._rebuildMemoryIndex(),
    });
    this._sessionStore = createSessionStore({
      db: this.db,
      sessionsPath: this.sessionsPath,
      createMemory: (input) => this._memoryStore.createMemory(input),
    });
  }

  ensureFiles() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.eventsPath)) fs.writeFileSync(this.eventsPath, "", "utf8");
    if (!fs.existsSync(this.sessionsPath)) fs.writeFileSync(this.sessionsPath, "", "utf8");
  }

  close() {
    this.db?.close();
  }

  initDb() {
    initSchema(this.db);
  }

  readEvents() {
    return readJsonl(this.eventsPath);
  }

  readSessionEvents() {
    return readJsonl(this.sessionsPath);
  }

  appendEvent(eventType, payload = {}, options = {}) {
    return this._memoryStore.appendEvent(eventType, payload, options);
  }

  rebuildIndex() {
    this._rebuildMemoryIndex();
    this._rebuildSessionIndex();
  }

  _rebuildMemoryIndex() {
    rebuildMemoryIndex({
      db: this.db,
      eventsPath: this.eventsPath,
      snapshotPath: this.snapshotPath,
    });
  }

  _rebuildSessionIndex() {
    rebuildSessionIndex(this.db, this.sessionsPath);
  }

  // ---------- Memory surface (delegated to ./store/memory-store.ts) ----------

  _listAll(filters = {}) {
    return this._memoryStore.listAll(filters);
  }

  listMemories(filters = {}) {
    return this._memoryStore.listMemories(filters);
  }

  getAggregates() {
    return this._memoryStore.getAggregates();
  }

  getRelated(id) {
    return this._memoryStore.getRelated(id);
  }

  getMemory(id) {
    return this._memoryStore.getMemory(id);
  }

  listEvents(filters = {}) {
    return this._memoryStore.listEvents(filters);
  }

  searchMemories(input = {}) {
    return this._memoryStore.searchMemories(input);
  }

  detectRelated(candidate, options = {}) {
    return this._memoryStore.detectRelated(candidate, options);
  }

  createMemory(input, options = {}) {
    return this._memoryStore.createMemory(input, options);
  }

  updateMemory(id, patch = {}, agent_id, options = {}) {
    return this._memoryStore.updateMemory(id, patch, agent_id, options);
  }

  deleteMemory(id, agent_id) {
    return this._memoryStore.deleteMemory(id, agent_id);
  }

  verifyMemory(id, result, note = "", agent_id) {
    return this._memoryStore.verifyMemory(id, result, note, agent_id);
  }

  recordRecall(memories, agent_id, query = "") {
    return this._memoryStore.recordRecall(memories, agent_id, query);
  }

  approveProposal(id, action = "approve", patch = {}, agent_id) {
    return this._memoryStore.approveProposal(id, action, patch, agent_id);
  }

  resolveConflict(input = {}) {
    return this._memoryStore.resolveConflict(input);
  }

  startContext(input = {}) {
    return this._memoryStore.startContext(input);
  }

  // ---------- Session surface (delegated to ./store/session-store.ts) ----------

  appendSessionEvent(eventType, payload = {}, options = {}) {
    return this._sessionStore.appendSessionEvent(eventType, payload, options);
  }

  startSession(input = {}) {
    return this._sessionStore.startSession(input);
  }

  getSession(id) {
    return this._sessionStore.getSession(id);
  }

  listSessions(input = {}) {
    return this._sessionStore.listSessions(input);
  }

  recordSessionEvent(input = {}) {
    return this._sessionStore.recordSessionEvent(input);
  }

  checkpointSession(input = {}) {
    return this._sessionStore.checkpointSession(input);
  }

  pauseSession(input = {}) {
    return this._sessionStore.pauseSession(input);
  }

  endSession(input = {}) {
    return this._sessionStore.endSession(input);
  }

  attachSession(input = {}) {
    return this._sessionStore.attachSession(input);
  }

  continueSession(input = {}) {
    return this._sessionStore.continueSession(input);
  }

  archiveSession(input = {}) {
    return this._sessionStore.archiveSession(input);
  }

  deleteSession(input = {}) {
    return this._sessionStore.deleteSession(input);
  }

  restoreSession(input = {}) {
    return this._sessionStore.restoreSession(input);
  }

  promoteSessionFact(input = {}) {
    return this._sessionStore.promoteSessionFact(input);
  }

  searchSessions(input = {}) {
    return this._sessionStore.searchSessions(input);
  }

  listSessionEvents(input = {}) {
    return this._sessionStore.listSessionEvents(input);
  }
}

export function formatRecall(memories, heading = "Relevant Memories") {
  if (!memories.length) return `${heading}\n\nNo relevant memories found.`;
  return `${heading}\n\n${memories.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`;
}
