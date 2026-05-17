import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_AGENT_ID,
  SESSION_CAPTURE_MODES,
  SESSION_PAYLOAD_TYPES,
  VISIBILITIES,
  asArray,
  isProtectedCategory,
  makeId,
  normalizeEnum,
  normalizeMemoryInput,
  normalizeString,
  nowIso
} from "./constants.js";

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        category TEXT NOT NULL,
        visibility TEXT NOT NULL,
        agent_id TEXT,
        scope TEXT NOT NULL,
        project_key TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        confidence TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        applies_to_json TEXT NOT NULL,
        supersedes_json TEXT NOT NULL,
        conflicts_with_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_recalled_at TEXT,
        recall_count INTEGER NOT NULL,
        usefulness_score INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        title,
        body,
        category,
        tags
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        memory_id TEXT,
        agent_id TEXT,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_key TEXT,
        status TEXT NOT NULL,
        prior_status TEXT,
        visibility TEXT NOT NULL,
        created_by_agent_id TEXT,
        current_agent_id TEXT,
        created_in_harness TEXT,
        current_harness TEXT,
        source_ref TEXT,
        cwd TEXT,
        start_summary TEXT,
        rolling_summary TEXT,
        end_summary TEXT,
        next_steps_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        capture_mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        paused_at TEXT,
        ended_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        harness TEXT,
        source_ref TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
        event_id UNINDEXED,
        session_id,
        summary,
        payload_text
      );
    `);
  }

  readEvents() {
    return readJsonl(this.eventsPath);
  }

  readSessionEvents() {
    return readJsonl(this.sessionsPath);
  }

  appendEvent(eventType, payload = {}, options = {}) {
    const event = {
      event_id: makeId("evt"),
      event_type: eventType,
      memory_id: options.memory_id || payload.memory_id || payload.memory?.id || null,
      agent_id: options.agent_id || payload.agent_id || payload.memory?.agent_id || DEFAULT_AGENT_ID,
      created_at: nowIso(),
      payload
    };
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    this.rebuildIndex();
    return event;
  }

  reduce(events = this.readEvents()) {
    const memories = new Map();
    const eventRows = [];

    for (const event of events) {
      eventRows.push(event);
      const payload = event.payload || {};
      const id = event.memory_id || payload.memory_id || payload.memory?.id;
      if (!id) continue;

      if (event.event_type === "memory.created" || event.event_type === "memory.proposed") {
        memories.set(id, { ...payload.memory });
        continue;
      }

      const existing = memories.get(id);
      if (!existing) continue;

      if (event.event_type === "memory.updated") {
        memories.set(id, {
          ...existing,
          ...payload.patch,
          id,
          updated_at: event.created_at
        });
      } else if (event.event_type === "memory.approved") {
        memories.set(id, {
          ...existing,
          ...payload.patch,
          status: "active",
          updated_at: event.created_at
        });
      } else if (event.event_type === "memory.rejected") {
        memories.set(id, {
          ...existing,
          status: "rejected",
          updated_at: event.created_at
        });
      } else if (event.event_type === "memory.deleted") {
        memories.set(id, {
          ...existing,
          status: "deleted",
          deleted_at: event.created_at,
          updated_at: event.created_at
        });
      } else if (event.event_type === "memory.archived") {
        memories.set(id, {
          ...existing,
          status: "archived",
          updated_at: event.created_at
        });
      } else if (event.event_type === "memory.recalled") {
        memories.set(id, {
          ...existing,
          last_recalled_at: event.created_at,
          recall_count: Number(existing.recall_count || 0) + 1,
          updated_at: existing.updated_at
        });
      } else if (event.event_type === "memory.verified") {
        const delta = payload.result === "useful" ? 1 : payload.result === "not_useful" ? -1 : -2;
        memories.set(id, {
          ...existing,
          usefulness_score: Number(existing.usefulness_score || 0) + delta,
          updated_at: event.created_at
        });
      } else if (event.event_type === "memory.conflict_detected") {
        const conflicts = new Set(asArray(existing.conflicts_with));
        for (const conflictId of asArray(payload.conflicts_with)) conflicts.add(conflictId);
        memories.set(id, {
          ...existing,
          status: existing.status === "proposed" ? "proposed" : "conflicted",
          conflicts_with: [...conflicts],
          updated_at: event.created_at
        });
      } else if (event.event_type === "memory.conflict_resolved") {
        memories.set(id, {
          ...existing,
          ...payload.patch,
          status: payload.status || "active",
          updated_at: event.created_at
        });
      }
    }

    return { memories: [...memories.values()], events: eventRows };
  }

  rebuildIndex() {
    const { memories, events } = this.reduce();
    const tx = this.db.prepare("BEGIN");
    const commit = this.db.prepare("COMMIT");
    const rollback = this.db.prepare("ROLLBACK");
    tx.run();
    try {
      this.db.exec("DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM events;");
      const insertMemory = this.db.prepare(`
        INSERT INTO memories (
          id, title, body, category, visibility, agent_id, scope, project_key,
          status, priority, confidence, tags_json, applies_to_json, supersedes_json,
          conflicts_with_json, created_at, updated_at, last_recalled_at, recall_count, usefulness_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare("INSERT INTO memories_fts (id, title, body, category, tags) VALUES (?, ?, ?, ?, ?)");
      const insertEvent = this.db.prepare(`
        INSERT INTO events (event_id, event_type, memory_id, agent_id, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const memory of memories) {
        insertMemory.run(
          memory.id,
          memory.title,
          memory.body,
          memory.category,
          memory.visibility,
          memory.agent_id || null,
          memory.scope,
          memory.project_key || null,
          memory.status,
          memory.priority,
          memory.confidence,
          JSON.stringify(asArray(memory.tags)),
          JSON.stringify(asArray(memory.applies_to)),
          JSON.stringify(asArray(memory.supersedes)),
          JSON.stringify(asArray(memory.conflicts_with)),
          memory.created_at,
          memory.updated_at,
          memory.last_recalled_at || null,
          Number(memory.recall_count || 0),
          Number(memory.usefulness_score || 0)
        );
        insertFts.run(memory.id, memory.title, memory.body, memory.category, asArray(memory.tags).join(" "));
      }

      for (const event of events) {
        insertEvent.run(
          event.event_id,
          event.event_type,
          event.memory_id || null,
          event.agent_id || null,
          event.created_at,
          JSON.stringify(event.payload || {})
        );
      }

      commit.run();
      this.writeSnapshot(memories);
    } catch (error) {
      rollback.run();
      throw error;
    }
  }

  writeSnapshot(memories) {
    const visible = memories
      .filter((memory) => memory.status !== "deleted" && memory.status !== "rejected")
      .sort((a, b) => {
        const keyA = `${a.status}:${a.category}:${a.title}`;
        const keyB = `${b.status}:${b.category}:${b.title}`;
        return keyA.localeCompare(keyB);
      });

    const lines = ["# The Librarian Memories", ""];
    for (const memory of visible) {
      lines.push(`## ${memory.title}`);
      lines.push("");
      lines.push(memory.body);
      lines.push("");
      lines.push(`- id: ${memory.id}`);
      lines.push(`- status: ${memory.status}`);
      lines.push(`- category: ${memory.category}`);
      lines.push(`- visibility: ${memory.visibility}${memory.agent_id ? ` (${memory.agent_id})` : ""}`);
      lines.push(`- scope: ${memory.scope}${memory.project_key ? ` (${memory.project_key})` : ""}`);
      lines.push(`- priority: ${memory.priority}`);
      lines.push(`- confidence: ${memory.confidence}`);
      if (asArray(memory.tags).length) lines.push(`- tags: ${asArray(memory.tags).join(", ")}`);
      lines.push("");
    }
    fs.writeFileSync(this.snapshotPath, `${lines.join("\n").trim()}\n`, "utf8");
  }

  _listAll(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
    if (filters.category) { clauses.push("category = ?"); params.push(filters.category); }
    if (filters.visibility) { clauses.push("visibility = ?"); params.push(filters.visibility); }
    if (filters.agent_id) { clauses.push("(visibility = 'common' OR agent_id = ?)"); params.push(filters.agent_id); }
    if (filters.project_key) { clauses.push("(project_key IS NULL OR project_key = ?)"); params.push(filters.project_key); }
    const sql = `SELECT * FROM memories ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY CASE priority WHEN 'core' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC`;
    return this.db.prepare(sql).all(...params).map(rowToMemory);
  }

  listMemories(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
    if (filters.category) { clauses.push("category = ?"); params.push(filters.category); }
    if (filters.visibility) { clauses.push("visibility = ?"); params.push(filters.visibility); }
    if (filters.agent_id) { clauses.push("(visibility = 'common' OR agent_id = ?)"); params.push(filters.agent_id); }
    if (filters.project_key) { clauses.push("(project_key IS NULL OR project_key = ?)"); params.push(filters.project_key); }
    if (filters.scope) { clauses.push("scope = ?"); params.push(filters.scope); }
    if (filters.from) { clauses.push("created_at >= ?"); params.push(filters.from); }
    if (filters.to) { clauses.push("created_at <= ?"); params.push(filters.to + "T23:59:59.999Z"); }

    const sortField = ["created_at", "updated_at", "title", "priority"].includes(filters.sort)
      ? filters.sort : "updated_at";
    const sortDir = filters.order === "asc" ? "ASC" : "DESC";
    const safeLimit = Math.min(Math.max(Number(filters.limit ?? 100), 1), 200);
    const safeOffset = Math.max(Number(filters.offset ?? 0), 0);

    const prioritySql = "CASE priority WHEN 'core' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
    const orderSql = sortField === "priority" ? `${prioritySql} ${sortDir}` : `${sortField} ${sortDir}`;
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const total = this.db.prepare(`SELECT COUNT(*) as n FROM memories ${whereClause}`).get(...params).n;
    const memories = this.db.prepare(`SELECT * FROM memories ${whereClause} ORDER BY ${orderSql} LIMIT ? OFFSET ?`).all(...params, safeLimit, safeOffset).map(rowToMemory);
    return { memories, total, limit: safeLimit, offset: safeOffset };
  }

  getAggregates() {
    const memories = this._listAll({});
    const active = memories.filter((m) => m.status !== "deleted");

    const tally = (field) => {
      const map = new Map();
      for (const m of active) {
        const v = m[field];
        if (!v) continue;
        map.set(v, (map.get(v) ?? 0) + 1);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
    };

    return {
      agents:     tally("agent_id"),
      projects:   tally("project_key"),
      categories: tally("category"),
      statuses:   tally("status"),
      scopes:     tally("scope"),
      priorities: tally("priority"),
      total:      active.length,
    };
  }

  getRelated(id) {
    const memory = this.getMemory(id);
    if (!memory) return null;

    const terms = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
    if (!terms.size) return { memory, related: [] };

    const pool = this._listAll({
      status: "active",
      agent_id: memory.agent_id,
      project_key: memory.project_key,
    }).filter((m) => m.id !== id && m.category === memory.category);

    const related = pool
      .map((other) => {
        const otherTerms = new Set(tokenize(`${other.title} ${other.body} ${other.tags.join(" ")}`));
        const overlap = [...terms].filter((t) => otherTerms.has(t)).length;
        const ratio = overlap / Math.max(terms.size, otherTerms.size, 1);
        const isDuplicate = ratio >= 0.55;
        const isConflict = ratio >= 0.32 && seemsConflict(memory.body, other.body);
        return { memory: other, ratio, isDuplicate, isConflict };
      })
      .filter((item) => item.ratio >= 0.32)
      .sort((a, b) => b.ratio - a.ratio);

    return { memory, related };
  }

  getMemory(id) {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? rowToMemory(row) : null;
  }

  listEvents({ type = "", agent_id = "", memory_id = "", result = "", query = "", limit = 25, offset = 0 } = {}) {
    const eventType = normalizeString(type);
    const agentId = normalizeString(agent_id);
    const memoryId = normalizeString(memory_id);
    const expectedResult = normalizeString(result);
    const searchQuery = normalizeString(query).toLowerCase();
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const filtered = this.readEvents()
      .filter((event) => {
        const payload = event.payload || {};
        if (eventType && event.event_type !== eventType) return false;
        if (agentId && event.agent_id !== agentId) return false;
        if (memoryId && event.memory_id !== memoryId) return false;
        if (expectedResult && payload.result !== expectedResult) return false;
        if (searchQuery) {
          const haystack = [
            event.event_type,
            event.agent_id,
            event.memory_id,
            payload.query,
            payload.result,
            payload.note,
            payload.memory?.title,
            payload.memory?.body,
            payload.patch?.title,
            payload.patch?.body
          ].filter(Boolean).join(" ").toLowerCase();
          if (!haystack.includes(searchQuery)) return false;
        }
        return true;
      })
      .reverse();

    return {
      events: filtered.slice(safeOffset, safeOffset + safeLimit),
      total: filtered.length,
      limit: safeLimit,
      offset: safeOffset
    };
  }

  searchMemories({ agent_id = DEFAULT_AGENT_ID, query = "", categories = [], project_key = "", include_private = true, limit = 8, status = "active" } = {}) {
    const cleaned = normalizeString(query);
    const categorySet = new Set(asArray(categories));
    const all = this._listAll({ status, agent_id: include_private ? agent_id : "", project_key });
    const allowed = all.filter((memory) => {
      if (categorySet.size && !categorySet.has(memory.category)) return false;
      if (memory.visibility === "agent_private" && (!include_private || memory.agent_id !== agent_id)) return false;
      return true;
    });

    if (!cleaned) return allowed.slice(0, limit);

    const terms = tokenize(cleaned);
    const scored = allowed.map((memory) => {
      const haystack = `${memory.title} ${memory.body} ${memory.category} ${memory.tags.join(" ")} ${memory.project_key || ""}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += term.length > 4 ? 3 : 1;
      }
      if (memory.priority === "core") score += 3;
      if (memory.priority === "high") score += 1;
      if (memory.project_key && memory.project_key === project_key) score += 3;
      return { memory, score };
    }).filter((item) => item.score > 0);

    scored.sort((a, b) => b.score - a.score || b.memory.updated_at.localeCompare(a.memory.updated_at));
    return scored.slice(0, limit).map((item) => item.memory);
  }

  detectRelated(candidate, options = {}) {
    const terms = new Set(tokenize(`${candidate.title} ${candidate.body} ${candidate.tags.join(" ")}`));
    if (!terms.size) return { duplicates: [], conflicts: [] };

    const pool = this._listAll({
      status: "active",
      agent_id: candidate.agent_id,
      project_key: candidate.project_key
    }).filter((memory) => memory.id !== candidate.id && memory.category === candidate.category);

    const related = pool.map((memory) => {
      const other = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
      const overlap = [...terms].filter((term) => other.has(term)).length;
      const ratio = overlap / Math.max(terms.size, other.size, 1);
      return { memory, ratio };
    }).filter((item) => item.ratio >= (options.threshold || 0.32));

    const duplicates = related.filter((item) => item.ratio >= 0.55).map((item) => item.memory);
    const conflicts = related
      .filter((item) => item.ratio >= 0.32 && seemsConflict(candidate.body, item.memory.body))
      .map((item) => item.memory);

    return { duplicates, conflicts };
  }

  createMemory(input, options = {}) {
    const normalized = normalizeMemoryInput(input);
    const protectedWrite = isProtectedCategory(normalized.category) && !options.forceActive;
    const status = options.status || (protectedWrite ? "proposed" : normalized.status);
    const memory = {
      id: makeId("mem"),
      ...normalized,
      status,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_recalled_at: null,
      recall_count: 0,
      usefulness_score: 0,
      supersedes: [],
      conflicts_with: []
    };

    const related = this.detectRelated(memory);
    if (related.conflicts.length && !options.allowConflict) {
      this.appendEvent("memory.conflict_detected", {
        agent_id: memory.agent_id,
        candidate: memory,
        conflicts_with: related.conflicts.map((item) => item.id)
      }, { memory_id: memory.id, agent_id: memory.agent_id });
      return {
        status: "conflict",
        message: "Potential conflicting memories found. Ask the agent or user to resolve before saving.",
        candidate: memory,
        conflicts: related.conflicts
      };
    }

    this.appendEvent(status === "proposed" ? "memory.proposed" : "memory.created", { memory }, { memory_id: memory.id, agent_id: memory.agent_id });
    return {
      status,
      memory,
      duplicates: related.duplicates
    };
  }

  updateMemory(id, patch = {}, agent_id = DEFAULT_AGENT_ID, options = {}) {
    const existing = this.getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (isProtectedCategory(existing.category) && existing.status === "active" && !options.allowProtected) {
      throw new Error("Protected memories must be changed through a proposal workflow.");
    }
    const normalizedPatch = cleanPatch(patch);
    if (normalizedPatch.status !== undefined && normalizedPatch.status !== existing.status) {
      throw new Error("Memory status changes must use the dedicated approval, delete, archive, or conflict-resolution workflow.");
    }
    if (
      normalizedPatch.category !== undefined &&
      normalizedPatch.category !== existing.category &&
      (isProtectedCategory(existing.category) || isProtectedCategory(normalizedPatch.category)) &&
      !options.allowProtected
    ) {
      throw new Error("Protected memory categories cannot be assigned or removed through update_memory.");
    }
    this.appendEvent("memory.updated", { memory_id: id, agent_id, patch: normalizedPatch }, { memory_id: id, agent_id });
    return this.getMemory(id);
  }

  deleteMemory(id, agent_id = DEFAULT_AGENT_ID) {
    const existing = this.getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    this.appendEvent("memory.deleted", { memory_id: id, agent_id }, { memory_id: id, agent_id });
    return this.getMemory(id);
  }

  verifyMemory(id, result, note = "", agent_id = DEFAULT_AGENT_ID) {
    const existing = this.getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    this.appendEvent("memory.verified", { memory_id: id, agent_id, result, note }, { memory_id: id, agent_id });
    return this.getMemory(id);
  }

  recordRecall(memories, agent_id = DEFAULT_AGENT_ID, query = "") {
    if (!memories.length) {
      this.appendEvent("memory.recall_empty", {
        agent_id,
        query,
        returned_count: 0
      }, { agent_id });
      return;
    }
    for (const memory of memories) {
      this.appendEvent("memory.recalled", { memory_id: memory.id, agent_id, query }, { memory_id: memory.id, agent_id });
    }
  }

  approveProposal(id, action = "approve", patch = {}, agent_id = DEFAULT_AGENT_ID) {
    const existing = this.getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status !== "proposed") throw new Error(`Memory ${id} is not proposed`);
    if (action === "reject") {
      this.appendEvent("memory.rejected", { memory_id: id, agent_id }, { memory_id: id, agent_id });
      return this.getMemory(id);
    }
    this.appendEvent("memory.approved", { memory_id: id, agent_id, patch: cleanPatch(patch) }, { memory_id: id, agent_id });
    return this.getMemory(id);
  }

  resolveConflict({ memory_ids = [], resolution = "keep_both", explanation = "", agent_id = DEFAULT_AGENT_ID, patch = {} } = {}) {
    const ids = asArray(memory_ids);
    if (!ids.length) throw new Error("memory_ids is required");
    const results = [];
    for (const id of ids) {
      const existing = this.getMemory(id);
      if (!existing) continue;
      if (isProtectedCategory(existing.category)) {
        throw new Error("Protected category conflicts require user approval through the dashboard.");
      }
      let status = "active";
      let eventPatch = cleanPatch(patch);
      if (resolution === "archive") status = "archived";
      if (resolution === "keep_both") status = "active";
      if (resolution === "supersede" && id !== ids[0]) status = "archived";
      this.appendEvent("memory.conflict_resolved", {
        memory_id: id,
        agent_id,
        resolution,
        explanation,
        status,
        patch: eventPatch
      }, { memory_id: id, agent_id });
      results.push(this.getMemory(id));
    }
    return results;
  }

  startContext({ agent_id = DEFAULT_AGENT_ID, project_key = "", task_summary = "" } = {}) {
    const identity = this._listAll({ status: "active", category: "identity" })
      .filter((memory) => memory.visibility === "common");
    const relationship = this._listAll({ status: "active", category: "relationship" })
      .filter((memory) => memory.visibility === "common");
    const privateMemories = this.searchMemories({
      agent_id,
      query: task_summary || project_key || agent_id,
      categories: [],
      project_key,
      include_private: true,
      limit: 6
    }).filter((memory) => memory.visibility === "agent_private" && memory.agent_id === agent_id);

    const relevant = task_summary || project_key
      ? this.searchMemories({
        agent_id,
        query: `${task_summary} ${project_key}`,
        categories: ["projects", "environment", "tools", "lessons", "open_threads", "preferences"],
        project_key,
        include_private: true,
        limit: 8
      }).filter((memory) => !["identity", "relationship"].includes(memory.category))
      : [];

    const memories = uniqueById([...identity, ...relationship, ...privateMemories, ...relevant]);
    this.recordRecall(memories, agent_id, task_summary || "start_context");
    return {
      memories,
      text: formatContextPackage({ identity, relationship, privateMemories, relevant })
    };
  }

  appendSessionEvent(eventType, payload = {}, options = {}) {
    const event = {
      event_id: makeId("sevt"),
      event_type: eventType,
      session_id: options.session_id || payload.session?.id || payload.session_id || null,
      agent_id: options.agent_id || payload.agent_id || DEFAULT_AGENT_ID,
      harness: options.harness ?? payload.harness ?? null,
      source_ref: options.source_ref ?? payload.source_ref ?? null,
      created_at: nowIso(),
      payload
    };
    fs.appendFileSync(this.sessionsPath, `${JSON.stringify(event)}\n`, "utf8");
    this._applySessionEvent(event);
    return event;
  }

  _applySessionEvent(event) {
    const type = event.event_type;
    if (type === "session.started") {
      const session = event.payload?.session;
      if (!session) return;
      this._insertSessionRow(session);
      this._insertSessionEventRow(event, eventSummary(event), shortType(type));
      return;
    }
    if (type === "session.event_recorded") {
      const session = this.getSession(event.session_id);
      if (!session) return;
      const payloadType = event.payload?.type;
      const summary = event.payload?.summary || "";
      const wasPaused = session.status === "paused";
      const updates = {
        last_activity_at: event.created_at,
        updated_at: event.created_at
      };
      if (wasPaused) {
        updates.status = "active";
        updates.paused_at = null;
      }
      this._patchSessionRow(session.id, updates);
      this._insertSessionEventRow(event, summary, payloadType);
      return;
    }
    if (type === "session.checkpointed") {
      const session = this.getSession(event.session_id);
      if (!session) return;
      const summary = event.payload?.summary || "";
      const nextSteps = event.payload?.next_steps;
      const updates = {
        rolling_summary: summary || session.rolling_summary,
        last_activity_at: event.created_at,
        updated_at: event.created_at
      };
      if (session.status === "paused") {
        updates.status = "active";
        updates.paused_at = null;
      }
      if (Array.isArray(nextSteps) && nextSteps.length) {
        updates.next_steps_json = JSON.stringify(asArray(nextSteps));
      }
      this._patchSessionRow(session.id, updates);
      this._insertSessionEventRow(event, summary || "Checkpoint.", shortType(type));
      return;
    }
    if (type === "session.paused") {
      const session = this.getSession(event.session_id);
      if (!session) return;
      const summary = event.payload?.summary || "";
      const nextSteps = event.payload?.next_steps;
      const updates = {
        status: "paused",
        rolling_summary: summary || session.rolling_summary,
        paused_at: event.created_at,
        last_activity_at: event.created_at,
        updated_at: event.created_at
      };
      if (Array.isArray(nextSteps) && nextSteps.length) {
        updates.next_steps_json = JSON.stringify(asArray(nextSteps));
      }
      this._patchSessionRow(session.id, updates);
      this._insertSessionEventRow(event, summary || "Session paused.", shortType(type));
      return;
    }
    if (type === "session.ended") {
      const session = this.getSession(event.session_id);
      if (!session) return;
      const summary = event.payload?.summary || "";
      const nextSteps = event.payload?.next_steps;
      const updates = {
        status: "ended",
        end_summary: summary,
        ended_at: event.created_at,
        last_activity_at: event.created_at,
        updated_at: event.created_at
      };
      if (Array.isArray(nextSteps) && nextSteps.length) {
        updates.next_steps_json = JSON.stringify(asArray(nextSteps));
      }
      this._patchSessionRow(session.id, updates);
      this._insertSessionEventRow(event, summary || "Session ended.", shortType(type));
      return;
    }
    if (type === "session.archived") {
      const session = this.getSession(event.session_id);
      if (!session) return;
      const updates = {
        status: "archived",
        archived_at: event.created_at,
        last_activity_at: event.created_at,
        updated_at: event.created_at
      };
      if (!["archived", "deleted"].includes(session.status)) {
        updates.prior_status = session.status;
      }
      this._patchSessionRow(session.id, updates);
      this._insertSessionEventRow(
        event,
        event.payload?.reason || "Session archived.",
        shortType(type)
      );
      return;
    }
    if (type === "session.deleted") {
      const session = this.getSession(event.session_id);
      if (!session) return;
      const updates = {
        status: "deleted",
        deleted_at: event.created_at,
        last_activity_at: event.created_at,
        updated_at: event.created_at
      };
      if (!["archived", "deleted"].includes(session.status)) {
        updates.prior_status = session.status;
      }
      this._patchSessionRow(session.id, updates);
      this._insertSessionEventRow(
        event,
        event.payload?.reason || "Session deleted.",
        shortType(type)
      );
      return;
    }
    if (type === "session.restored") {
      const session = this.getSession(event.session_id);
      if (!session) return;
      const restoreTo = event.payload?.restore_to || session.prior_status || "paused";
      this._patchSessionRow(session.id, {
        status: restoreTo,
        prior_status: null,
        archived_at: null,
        deleted_at: null,
        last_activity_at: event.created_at,
        updated_at: event.created_at
      });
      this._insertSessionEventRow(event, `Restored to ${restoreTo}.`, shortType(type));
    }
  }

  _patchSessionRow(id, patch) {
    const allowed = [
      "title", "project_key", "status", "prior_status", "visibility",
      "created_by_agent_id", "current_agent_id", "created_in_harness", "current_harness",
      "source_ref", "cwd", "start_summary", "rolling_summary", "end_summary",
      "next_steps_json", "tags_json", "capture_mode",
      "started_at", "updated_at", "last_activity_at",
      "paused_at", "ended_at", "archived_at", "deleted_at", "metadata_json"
    ];
    const keys = [];
    const params = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        keys.push(`${key} = ?`);
        params.push(patch[key]);
      }
    }
    if (!keys.length) return;
    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${keys.join(", ")} WHERE id = ?`).run(...params);
  }

  _insertSessionRow(session) {
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, title, project_key, status, prior_status, visibility,
        created_by_agent_id, current_agent_id, created_in_harness, current_harness,
        source_ref, cwd, start_summary, rolling_summary, end_summary,
        next_steps_json, tags_json, capture_mode,
        started_at, updated_at, last_activity_at,
        paused_at, ended_at, archived_at, deleted_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.title,
      session.project_key || null,
      session.status,
      session.prior_status || null,
      session.visibility,
      session.created_by_agent_id || null,
      session.current_agent_id || null,
      session.created_in_harness || null,
      session.current_harness || null,
      session.source_ref || null,
      session.cwd || null,
      session.start_summary || null,
      session.rolling_summary || null,
      session.end_summary || null,
      JSON.stringify(asArray(session.next_steps)),
      JSON.stringify(asArray(session.tags)),
      session.capture_mode,
      session.started_at,
      session.updated_at,
      session.last_activity_at,
      session.paused_at || null,
      session.ended_at || null,
      session.archived_at || null,
      session.deleted_at || null,
      JSON.stringify(session.metadata || {})
    );
  }

  _insertSessionEventRow(event, summary, type) {
    this.db.prepare(`
      INSERT OR REPLACE INTO session_events (
        id, session_id, type, agent_id, harness, source_ref, summary, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.session_id,
      type,
      event.agent_id || null,
      event.harness || null,
      event.source_ref || null,
      summary,
      JSON.stringify(event.payload || {}),
      event.created_at
    );
    this.db.prepare(`
      INSERT INTO session_events_fts (event_id, session_id, summary, payload_text)
      VALUES (?, ?, ?, ?)
    `).run(
      event.event_id,
      event.session_id,
      summary,
      JSON.stringify(event.payload || {})
    );
  }

  startSession(input = {}) {
    const now = nowIso();
    const harness = normalizeString(input.harness) || null;
    const projectKey = normalizeString(input.project_key) || null;
    const agentId = normalizeString(input.agent_id, DEFAULT_AGENT_ID);
    const visibility = normalizeEnum(input.visibility, VISIBILITIES, "common");
    const captureMode = normalizeEnum(input.capture_mode, SESSION_CAPTURE_MODES, "summary");
    const title = normalizeString(input.title) || `${projectKey || harness || "agent"} session @ ${now}`;

    const session = {
      id: makeId("ses"),
      title,
      project_key: projectKey,
      status: "active",
      prior_status: null,
      visibility,
      created_by_agent_id: agentId,
      current_agent_id: agentId,
      created_in_harness: harness,
      current_harness: harness,
      source_ref: normalizeString(input.source_ref) || null,
      cwd: normalizeString(input.cwd) || null,
      start_summary: normalizeString(input.start_summary) || null,
      rolling_summary: null,
      end_summary: null,
      next_steps: asArray(input.next_steps),
      tags: asArray(input.tags),
      capture_mode: captureMode,
      started_at: now,
      updated_at: now,
      last_activity_at: now,
      paused_at: null,
      ended_at: null,
      archived_at: null,
      deleted_at: null,
      metadata: isPlainObject(input.metadata) ? input.metadata : {}
    };

    this.appendSessionEvent(
      "session.started",
      { session, agent_id: agentId },
      {
        session_id: session.id,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref
      }
    );

    return { session: this.getSession(session.id) };
  }

  getSession(id) {
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return rowToSession(row);
  }

  listSessions(input = {}) {
    const agentId = normalizeString(input.agent_id);
    const isAdmin = input.admin === true;
    const projectKey = normalizeString(input.project_key) || null;
    const sourceRef = normalizeString(input.source_ref) || null;
    const cwd = normalizeString(input.cwd) || null;
    const harness = normalizeString(input.harness) || null;
    const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 100);

    const requested = asArray(input.status);
    const statusSet = new Set(requested.length ? requested : ["active", "paused", "ended"]);
    if (input.include_archived) statusSet.add("archived");
    if (input.include_deleted) statusSet.add("deleted");
    const statuses = [...statusSet];

    if (!statuses.length) return { sessions: [], total: 0, limit };

    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM sessions WHERE status IN (${placeholders})`).all(...statuses);
    const sessions = rows.map(rowToSession);

    const visible = sessions.filter((session) => {
      if (isAdmin) return true;
      if (session.visibility === "common") return true;
      return agentId && session.created_by_agent_id === agentId;
    });

    const filtered = visible.filter((session) => {
      if (harness && session.current_harness !== harness) return false;
      return true;
    });

    const scored = filtered.map((session) => ({
      session,
      key: [
        statusPriority(session.status),
        projectKey && session.project_key === projectKey ? 0 : 1,
        sourceMatches(session, sourceRef, cwd) ? 0 : 1,
        (session.next_steps || []).length > 0 ? 0 : 1,
        -Date.parse(session.last_activity_at || session.started_at || 0)
      ]
    }));

    scored.sort((a, b) => compareKeys(a.key, b.key));

    return {
      sessions: scored.slice(0, limit).map(({ session }) => session),
      total: scored.length,
      limit
    };
  }

  recordSessionEvent(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const type = normalizeString(input.type);
    if (!SESSION_PAYLOAD_TYPES.includes(type)) {
      throw new Error(`Unknown session event payload type: ${type || "(empty)"}`);
    }
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    assertSessionMutable(session, "record an event on");

    const agentId = normalizeString(input.agent_id, session.current_agent_id || DEFAULT_AGENT_ID);
    const harness = normalizeString(input.harness) || session.current_harness || null;
    const sourceRef = normalizeString(input.source_ref) || session.source_ref || null;
    const summary = normalizeString(input.summary);
    const extra = isPlainObject(input.payload) ? input.payload : {};

    const payload = {
      type,
      summary,
      agent_id: agentId,
      ...extra
    };

    return this.appendSessionEvent("session.event_recorded", payload, {
      session_id: sessionId,
      agent_id: agentId,
      harness,
      source_ref: sourceRef
    });
  }

  checkpointSession(input = {}) {
    return this._lifecycleEvent("session.checkpointed", input, "checkpoint");
  }

  pauseSession(input = {}) {
    return this._lifecycleEvent("session.paused", input, "pause");
  }

  endSession(input = {}) {
    return this._lifecycleEvent("session.ended", input, "end");
  }

  archiveSession(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    if (!canTransitionTo("archived", session.status)) {
      throw new Error(`Cannot archive a ${session.status} session (${sessionId}).`);
    }
    const agentId = normalizeString(input.agent_id, session.current_agent_id || DEFAULT_AGENT_ID);
    this.appendSessionEvent(
      "session.archived",
      {
        agent_id: agentId,
        reason: normalizeString(input.reason),
        prior_status: session.status
      },
      {
        session_id: sessionId,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref
      }
    );
    return { session: this.getSession(sessionId) };
  }

  deleteSession(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    if (!canTransitionTo("deleted", session.status)) {
      throw new Error(`Cannot delete a ${session.status} session (${sessionId}).`);
    }
    const agentId = normalizeString(input.agent_id, DEFAULT_AGENT_ID);
    if (input.admin !== true && session.created_by_agent_id !== agentId) {
      throw new Error(
        `Only the session owner or an admin may delete this session (${sessionId}).`
      );
    }
    this.appendSessionEvent(
      "session.deleted",
      {
        agent_id: agentId,
        reason: normalizeString(input.reason)
      },
      {
        session_id: sessionId,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref
      }
    );
    return { session: this.getSession(sessionId) };
  }

  restoreSession(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    if (!canTransitionTo("restored", session.status)) {
      throw new Error(`Cannot restore a ${session.status} session (${sessionId}).`);
    }
    const agentId = normalizeString(input.agent_id, DEFAULT_AGENT_ID);
    if (input.admin !== true && session.created_by_agent_id !== agentId) {
      throw new Error(
        `Only the session owner or an admin may restore this session (${sessionId}).`
      );
    }
    const restoreTo = session.prior_status || "paused";
    this.appendSessionEvent(
      "session.restored",
      {
        agent_id: agentId,
        restore_to: restoreTo,
        from_status: session.status
      },
      {
        session_id: sessionId,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref
      }
    );
    return { session: this.getSession(sessionId) };
  }

  _lifecycleEvent(eventType, input, action) {
    const sessionId = normalizeString(input.session_id);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    assertSessionMutable(session, action);

    const agentId = normalizeString(input.agent_id, session.current_agent_id || DEFAULT_AGENT_ID);
    const harness = normalizeString(input.harness) || session.current_harness || null;
    const sourceRef = normalizeString(input.source_ref) || session.source_ref || null;
    const summary = normalizeString(input.summary);

    const payload = {
      summary,
      agent_id: agentId,
      decisions: asArray(input.decisions),
      files_touched: asArray(input.files_touched),
      commands_run: asArray(input.commands_run),
      open_questions: asArray(input.open_questions),
      next_steps: asArray(input.next_steps)
    };
    if (eventType === "session.ended" && Array.isArray(input.candidate_memories)) {
      payload.candidate_memories = input.candidate_memories;
    }

    this.appendSessionEvent(eventType, payload, {
      session_id: sessionId,
      agent_id: agentId,
      harness,
      source_ref: sourceRef
    });

    return { session: this.getSession(sessionId) };
  }

  listSessionEvents(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const type = normalizeString(input.type);
    const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
    const offset = Math.max(Number(input.offset ?? 0), 0);

    const clauses = ["session_id = ?"];
    const params = [sessionId];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    const whereSql = `WHERE ${clauses.join(" AND ")}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM session_events ${whereSql}`).get(...params).n;
    const rows = this.db
      .prepare(`SELECT * FROM session_events ${whereSql} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    return {
      events: rows.map(rowToSessionEvent),
      total,
      limit,
      offset
    };
  }
}

function canTransitionTo(target, currentStatus) {
  if (target === "archived") return ["active", "paused", "ended"].includes(currentStatus);
  if (target === "deleted") return ["active", "paused", "ended", "archived"].includes(currentStatus);
  if (target === "restored") return ["archived", "deleted"].includes(currentStatus);
  return false;
}

function assertSessionMutable(session, action) {
  if (session.status === "ended") {
    throw new Error(`Cannot ${action} an ended session (${session.id}); start a new one with continues_from instead.`);
  }
  if (session.status === "archived") {
    throw new Error(`Cannot ${action} an archived session (${session.id}); restore it first.`);
  }
  if (session.status === "deleted") {
    throw new Error(`Cannot ${action} a deleted session (${session.id}); restore it first.`);
  }
}

function statusPriority(status) {
  if (status === "active") return 0;
  if (status === "paused") return 1;
  if (status === "ended") return 2;
  if (status === "archived") return 3;
  if (status === "deleted") return 4;
  return 5;
}

function sourceMatches(session, sourceRef, cwd) {
  if (sourceRef && session.source_ref === sourceRef) return true;
  if (cwd && session.cwd === cwd) return true;
  return false;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function eventSummary(event) {
  const type = event.event_type;
  if (type === "session.started") {
    return event.payload?.session?.start_summary || event.payload?.session?.title || "Session started.";
  }
  return type;
}

function shortType(eventType) {
  return eventType.startsWith("session.") ? eventType.slice("session.".length) : eventType;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL event in ${filePath} at line ${index + 1}: ${error.message}`);
    }
  });
}

function rowToSessionEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    type: row.type,
    agent_id: row.agent_id,
    harness: row.harness,
    source_ref: row.source_ref,
    summary: row.summary,
    payload: JSON.parse(row.payload_json || "{}"),
    created_at: row.created_at
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    project_key: row.project_key,
    status: row.status,
    prior_status: row.prior_status,
    visibility: row.visibility,
    created_by_agent_id: row.created_by_agent_id,
    current_agent_id: row.current_agent_id,
    created_in_harness: row.created_in_harness,
    current_harness: row.current_harness,
    source_ref: row.source_ref,
    cwd: row.cwd,
    start_summary: row.start_summary,
    rolling_summary: row.rolling_summary,
    end_summary: row.end_summary,
    next_steps: JSON.parse(row.next_steps_json || "[]"),
    tags: JSON.parse(row.tags_json || "[]"),
    capture_mode: row.capture_mode,
    started_at: row.started_at,
    updated_at: row.updated_at,
    last_activity_at: row.last_activity_at,
    paused_at: row.paused_at,
    ended_at: row.ended_at,
    archived_at: row.archived_at,
    deleted_at: row.deleted_at,
    metadata: JSON.parse(row.metadata_json || "{}")
  };
}

function rowToMemory(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags_json || "[]"),
    applies_to: JSON.parse(row.applies_to_json || "[]"),
    supersedes: JSON.parse(row.supersedes_json || "[]"),
    conflicts_with: JSON.parse(row.conflicts_with_json || "[]"),
    recall_count: Number(row.recall_count || 0),
    usefulness_score: Number(row.usefulness_score || 0)
  };
}

function tokenize(text) {
  return normalizeString(text)
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .filter((term) => !["the", "and", "for", "with", "that", "this", "from", "into", "agent", "memory"].includes(term));
}

function seemsConflict(a, b) {
  const left = normalizeString(a).toLowerCase();
  const right = normalizeString(b).toLowerCase();
  const negations = ["not", "never", "avoid", "prefer", "must", "should"];
  const sharedNegation = negations.some((word) => left.includes(word) && right.includes(word));
  const oppositeSignals = (left.includes("prefer") && right.includes("avoid")) || (left.includes("avoid") && right.includes("prefer"));
  return oppositeSignals || sharedNegation;
}

function cleanPatch(patch = {}) {
  const allowed = [
    "title",
    "body",
    "category",
    "visibility",
    "agent_id",
    "scope",
    "project_key",
    "applies_to",
    "status",
    "priority",
    "confidence",
    "supersedes",
    "conflicts_with",
    "tags"
  ];
  const output = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) output[key] = Array.isArray(patch[key]) ? asArray(patch[key]) : patch[key];
  }
  return output;
}

function uniqueById(memories) {
  const seen = new Set();
  const output = [];
  for (const memory of memories) {
    if (!memory || seen.has(memory.id)) continue;
    seen.add(memory.id);
    output.push(memory);
  }
  return output;
}

function formatContextPackage({ identity, relationship, privateMemories, relevant }) {
  const sections = [];
  sections.push("Memory Context");
  sections.push("");
  sections.push(formatSection("Identity", identity));
  sections.push(formatSection("Relationship", relationship));
  if (privateMemories.length) sections.push(formatSection("Agent Operating Notes", privateMemories));
  if (relevant.length) sections.push(formatSection("Relevant Working Context", relevant));
  return sections.filter(Boolean).join("\n\n").trim() || "Memory Context\n\nNo active memories found yet.";
}

export function formatRecall(memories, heading = "Relevant Memories") {
  if (!memories.length) return `${heading}\n\nNo relevant memories found.`;
  return `${heading}\n\n${memories.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`;
}

function formatSection(title, memories) {
  if (!memories.length) return `${title}\nNo active memories found.`;
  return `${title}\n${memories.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`;
}
