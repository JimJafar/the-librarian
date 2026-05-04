import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_AGENT_ID,
  asArray,
  isProtectedCategory,
  makeId,
  normalizeMemoryInput,
  normalizeString,
  nowIso
} from "./constants.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

export class LibrarianStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.env.LIBRARIAN_DATA_DIR || DEFAULT_DATA_DIR;
    this.eventsPath = path.join(this.dataDir, "events.jsonl");
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
    `);
  }

  readEvents() {
    const raw = fs.readFileSync(this.eventsPath, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL event at line ${index + 1}: ${error.message}`);
      }
    });
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

  listMemories(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.category) {
      clauses.push("category = ?");
      params.push(filters.category);
    }
    if (filters.visibility) {
      clauses.push("visibility = ?");
      params.push(filters.visibility);
    }
    if (filters.agent_id) {
      clauses.push("(visibility = 'common' OR agent_id = ?)");
      params.push(filters.agent_id);
    }
    if (filters.project_key) {
      clauses.push("(project_key IS NULL OR project_key = ?)");
      params.push(filters.project_key);
    }
    const sql = `
      SELECT * FROM memories
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY
        CASE priority WHEN 'core' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        updated_at DESC
    `;
    return this.db.prepare(sql).all(...params).map(rowToMemory);
  }

  getMemory(id) {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? rowToMemory(row) : null;
  }

  searchMemories({ agent_id = DEFAULT_AGENT_ID, query = "", categories = [], project_key = "", include_private = true, limit = 8, status = "active" } = {}) {
    const cleaned = normalizeString(query);
    const categorySet = new Set(asArray(categories));
    const all = this.listMemories({ status, agent_id: include_private ? agent_id : "", project_key });
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

    const pool = this.listMemories({
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

  updateMemory(id, patch = {}, agent_id = DEFAULT_AGENT_ID) {
    const existing = this.getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (isProtectedCategory(existing.category) && existing.status === "active") {
      throw new Error("Protected memories must be changed through a proposal workflow.");
    }
    const normalizedPatch = cleanPatch(patch);
    if (normalizedPatch.status !== undefined && normalizedPatch.status !== existing.status) {
      throw new Error("Memory status changes must use the dedicated approval, delete, archive, or conflict-resolution workflow.");
    }
    if (
      normalizedPatch.category !== undefined &&
      normalizedPatch.category !== existing.category &&
      (isProtectedCategory(existing.category) || isProtectedCategory(normalizedPatch.category))
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
    const identity = this.listMemories({ status: "active", category: "identity" })
      .filter((memory) => memory.visibility === "common");
    const relationship = this.listMemories({ status: "active", category: "relationship" })
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
