import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_AGENT_ID,
  SESSION_CAPTURE_MODES,
  SESSION_PAYLOAD_TYPES,
  VISIBILITIES,
  asArray,
  makeId,
  normalizeEnum,
  normalizeString,
  nowIso,
} from "@librarian/core/constants";
import {
  applySessionEvent,
  appendJsonl,
  createMemoryStore,
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

  updateMemory(id, patch = {}, agent_id = DEFAULT_AGENT_ID, options = {}) {
    return this._memoryStore.updateMemory(id, patch, agent_id, options);
  }

  deleteMemory(id, agent_id = DEFAULT_AGENT_ID) {
    return this._memoryStore.deleteMemory(id, agent_id);
  }

  verifyMemory(id, result, note = "", agent_id = DEFAULT_AGENT_ID) {
    return this._memoryStore.verifyMemory(id, result, note, agent_id);
  }

  recordRecall(memories, agent_id = DEFAULT_AGENT_ID, query = "") {
    return this._memoryStore.recordRecall(memories, agent_id, query);
  }

  approveProposal(id, action = "approve", patch = {}, agent_id = DEFAULT_AGENT_ID) {
    return this._memoryStore.approveProposal(id, action, patch, agent_id);
  }

  resolveConflict(input = {}) {
    return this._memoryStore.resolveConflict(input);
  }

  startContext(input = {}) {
    return this._memoryStore.startContext(input);
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
      payload,
    };
    appendJsonl(this.sessionsPath, event);
    this._applySessionEvent(event);
    return event;
  }

  _applySessionEvent(event) {
    applySessionEvent(this.db, event);
  }

  startSession(input = {}) {
    const now = nowIso();
    const harness = normalizeString(input.harness) || null;
    const projectKey = normalizeString(input.project_key) || null;
    const agentId = normalizeString(input.agent_id, DEFAULT_AGENT_ID);
    const visibility = normalizeEnum(input.visibility, VISIBILITIES, "common");
    const captureMode = normalizeEnum(input.capture_mode, SESSION_CAPTURE_MODES, "summary");
    const title =
      normalizeString(input.title) || `${projectKey || harness || "agent"} session @ ${now}`;

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
      metadata: isPlainObject(input.metadata) ? input.metadata : {},
    };

    this.appendSessionEvent(
      "session.started",
      { session, agent_id: agentId },
      {
        session_id: session.id,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref,
      },
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
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status IN (${placeholders})`)
      .all(...statuses);
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
        -Date.parse(session.last_activity_at || session.started_at || 0),
      ],
    }));

    scored.sort((a, b) => compareKeys(a.key, b.key));

    return {
      sessions: scored.slice(0, limit).map(({ session }) => session),
      total: scored.length,
      limit,
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
      ...extra,
    };

    return this.appendSessionEvent("session.event_recorded", payload, {
      session_id: sessionId,
      agent_id: agentId,
      harness,
      source_ref: sourceRef,
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

  attachSession(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    assertSessionMutable(session, "attach");

    const agentId = normalizeString(input.agent_id, session.current_agent_id || DEFAULT_AGENT_ID);
    const harness = normalizeString(input.harness) || session.current_harness || null;
    const sourceRef = normalizeString(input.source_ref) || session.source_ref || null;
    const cwd = normalizeString(input.cwd) || session.cwd || null;

    this.appendSessionEvent(
      "session.attached_to_harness",
      {
        agent_id: agentId,
        harness,
        source_ref: sourceRef,
        cwd,
        previous_agent_id: session.current_agent_id,
        previous_harness: session.current_harness,
        previous_source_ref: session.source_ref,
        previous_cwd: session.cwd,
      },
      { session_id: sessionId, agent_id: agentId, harness, source_ref: sourceRef },
    );

    return { session: this.getSession(sessionId) };
  }

  continueSession(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);

    const attach = input.attach !== false;
    const targetHarness = normalizeString(input.target_harness) || null;
    const targetSourceRef = normalizeString(input.target_source_ref) || null;
    const targetCwd = normalizeString(input.target_cwd) || null;
    const format = normalizeString(input.format) || "prose";
    const agentId = normalizeString(input.agent_id, session.current_agent_id || DEFAULT_AGENT_ID);

    const wantsHarnessSwap = targetHarness && targetHarness !== session.current_harness;
    const wantsSourceSwap = targetSourceRef && targetSourceRef !== session.source_ref;
    const shouldAttach = attach && (wantsHarnessSwap || wantsSourceSwap);

    let working = session;
    if (shouldAttach) {
      working = this.attachSession({
        session_id: sessionId,
        agent_id: agentId,
        harness: targetHarness || session.current_harness,
        source_ref: targetSourceRef || session.source_ref,
        cwd: targetCwd || session.cwd,
      }).session;
    }

    const original = this._getOriginalSessionSnapshot(sessionId) || session;
    const aggregates = this._aggregateHandoverInputs(sessionId);

    const handover = {
      id: working.id,
      title: working.title,
      project_key: working.project_key,
      status: working.status,
      visibility: working.visibility,
      created_in_harness: original.created_in_harness || working.created_in_harness,
      created_source_ref: original.source_ref || null,
      current_harness: working.current_harness,
      current_source_ref: working.source_ref,
      current_cwd: working.cwd,
      start_summary: working.start_summary,
      rolling_summary: working.rolling_summary,
      end_summary: working.end_summary,
      decisions: aggregates.decisions,
      files_touched: aggregates.files,
      commands_run: aggregates.commands,
      open_questions: aggregates.questions,
      next_steps: working.next_steps || [],
      tags: working.tags || [],
      last_activity_at: working.last_activity_at,
    };

    return {
      session: working,
      handover,
      text: renderHandover(handover, format),
      format,
    };
  }

  _getOriginalSessionSnapshot(sessionId) {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM session_events WHERE session_id = ? AND type = 'started' ORDER BY created_at ASC LIMIT 1`,
      )
      .get(sessionId);
    if (!row) return null;
    const payload = JSON.parse(row.payload_json || "{}");
    return payload.session || null;
  }

  _aggregateHandoverInputs(sessionId) {
    const rows = this.db
      .prepare(
        `SELECT type, payload_json FROM session_events WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId);
    const decisions = [];
    const files = [];
    const commands = [];
    const questions = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json || "{}");
      if (row.type === "decision" && payload.summary) decisions.push(payload.summary);
      if (row.type === "file" && payload.summary) files.push(payload.summary);
      if (row.type === "command" && payload.summary) commands.push(payload.summary);
      if (row.type === "question" && payload.summary) questions.push(payload.summary);
      if (["checkpointed", "paused", "ended"].includes(row.type)) {
        for (const d of asArray(payload.decisions)) decisions.push(d);
        for (const f of asArray(payload.files_touched)) files.push(f);
        for (const c of asArray(payload.commands_run)) commands.push(c);
        for (const q of asArray(payload.open_questions)) questions.push(q);
      }
    }
    return { decisions, files, commands, questions };
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
        prior_status: session.status,
      },
      {
        session_id: sessionId,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref,
      },
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
      throw new Error(`Only the session owner or an admin may delete this session (${sessionId}).`);
    }
    this.appendSessionEvent(
      "session.deleted",
      {
        agent_id: agentId,
        reason: normalizeString(input.reason),
      },
      {
        session_id: sessionId,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref,
      },
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
        `Only the session owner or an admin may restore this session (${sessionId}).`,
      );
    }
    const restoreTo = session.prior_status || "paused";
    this.appendSessionEvent(
      "session.restored",
      {
        agent_id: agentId,
        restore_to: restoreTo,
        from_status: session.status,
      },
      {
        session_id: sessionId,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref,
      },
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
      next_steps: asArray(input.next_steps),
    };
    if (eventType === "session.ended" && Array.isArray(input.candidate_memories)) {
      payload.candidate_memories = input.candidate_memories;
    }

    this.appendSessionEvent(eventType, payload, {
      session_id: sessionId,
      agent_id: agentId,
      harness,
      source_ref: sourceRef,
    });

    return { session: this.getSession(sessionId) };
  }

  promoteSessionFact(input = {}) {
    const sessionId = normalizeString(input.session_id);
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);

    const memoryInput = input.memory || {};
    const hasContent =
      normalizeString(memoryInput.title) ||
      normalizeString(memoryInput.body) ||
      normalizeString(memoryInput.content);
    if (!hasContent) {
      throw new Error("promote_session_fact requires a memory with a title or body.");
    }

    const agentId = normalizeString(input.agent_id, session.current_agent_id || DEFAULT_AGENT_ID);
    const sessionEventId = normalizeString(input.session_event_id) || null;

    const memoryResult = this.createMemory({
      ...memoryInput,
      agent_id: memoryInput.agent_id || agentId,
    });

    if (memoryResult.status === "conflict") {
      return {
        status: "conflict",
        conflicts: memoryResult.conflicts,
        candidate: memoryResult.candidate,
        session_id: sessionId,
        session_event_id: sessionEventId,
      };
    }

    this.appendSessionEvent(
      "session.promoted_to_memory",
      {
        agent_id: agentId,
        memory_id: memoryResult.memory.id,
        session_event_id: sessionEventId,
        memory_status: memoryResult.status,
        memory_category: memoryResult.memory.category,
        title: memoryResult.memory.title,
      },
      {
        session_id: sessionId,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref,
      },
    );

    return {
      status: memoryResult.status,
      memory: memoryResult.memory,
      duplicates: memoryResult.duplicates || [],
      session_id: sessionId,
      session_event_id: sessionEventId,
    };
  }

  searchSessions(input = {}) {
    const query = normalizeString(input.query);
    const agentId = normalizeString(input.agent_id);
    const isAdmin = input.admin === true;
    const projectKey = normalizeString(input.project_key) || null;
    const includeArchived = input.include_archived === true;
    const includeDeleted = input.include_deleted === true && isAdmin;
    const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 50);

    if (!query) return { sessions: [], total: 0, limit };

    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return { sessions: [], total: 0, limit };

    let matchedIds;
    try {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT session_id FROM session_events_fts WHERE session_events_fts MATCH ?`,
        )
        .all(ftsQuery);
      matchedIds = rows.map((row) => row.session_id).filter(Boolean);
    } catch {
      return { sessions: [], total: 0, limit };
    }

    if (!matchedIds.length) return { sessions: [], total: 0, limit };

    const placeholders = matchedIds.map(() => "?").join(", ");
    const sessions = this.db
      .prepare(`SELECT * FROM sessions WHERE id IN (${placeholders})`)
      .all(...matchedIds)
      .map(rowToSession);

    const filtered = sessions.filter((session) => {
      if (!includeDeleted && session.status === "deleted") return false;
      if (!includeArchived && session.status === "archived") return false;
      if (
        !isAdmin &&
        session.visibility === "agent_private" &&
        session.created_by_agent_id !== agentId
      )
        return false;
      if (projectKey && session.project_key !== projectKey) return false;
      return true;
    });

    filtered.sort((a, b) => (b.last_activity_at || "").localeCompare(a.last_activity_at || ""));

    return {
      sessions: filtered.slice(0, limit),
      total: filtered.length,
      limit,
    };
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
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session_events ${whereSql}`)
      .get(...params).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM session_events ${whereSql} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    return {
      events: rows.map(rowToSessionEvent),
      total,
      limit,
      offset,
    };
  }
}

function canTransitionTo(target, currentStatus) {
  if (target === "archived") return ["active", "paused", "ended"].includes(currentStatus);
  if (target === "deleted")
    return ["active", "paused", "ended", "archived"].includes(currentStatus);
  if (target === "restored") return ["archived", "deleted"].includes(currentStatus);
  return false;
}

function assertSessionMutable(session, action) {
  if (session.status === "ended") {
    throw new Error(
      `Cannot ${action} an ended session (${session.id}); start a new one with continues_from instead.`,
    );
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

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFtsQuery(query) {
  const tokens = String(query)
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (!tokens.length) return "";
  return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" ");
}

function renderHandover(handover, format) {
  if (format === "prose") return renderHandoverProse(handover);
  return renderHandoverMarkdown(handover);
}

function renderHandoverProse(handover) {
  const parts = [];
  const project = handover.project_key ? ` on project ${handover.project_key}` : "";
  parts.push(
    `Session "${handover.title}" (${handover.id})${project} is currently ${handover.status}.`,
  );
  const origin = handover.created_in_harness || "unknown harness";
  const dest = handover.current_harness || "unknown harness";
  parts.push(`Started in ${origin}; continuing in ${dest}.`);
  if (handover.start_summary) parts.push(`Goal: ${handover.start_summary}`);
  if (handover.rolling_summary) parts.push(`Current state: ${handover.rolling_summary}`);
  if (handover.end_summary) parts.push(`End summary: ${handover.end_summary}`);
  if (handover.decisions.length) parts.push(`Decisions so far: ${handover.decisions.join("; ")}.`);
  if (handover.files_touched.length)
    parts.push(`Files touched: ${handover.files_touched.join(", ")}.`);
  if (handover.commands_run.length)
    parts.push(`Commands run: ${handover.commands_run.join("; ")}.`);
  if (handover.open_questions.length)
    parts.push(`Open questions: ${handover.open_questions.join("; ")}.`);
  if (handover.next_steps.length) parts.push(`Next steps: ${handover.next_steps.join("; ")}.`);
  parts.push(
    "Treat this as session evidence, not durable memory; use remember/propose_memory for durable facts.",
  );
  return parts.join(" ");
}

function renderHandoverMarkdown(handover) {
  const lines = [
    "# Librarian Session Handover",
    "",
    `Session: ${handover.title}`,
    `ID: ${handover.id}`,
    `Project: ${handover.project_key || "(none)"}`,
    `Status: ${handover.status}`,
    `Created in: ${formatLocation(handover.created_in_harness, handover.created_source_ref)}`,
    `Continuing in: ${formatLocation(handover.current_harness, handover.current_source_ref)}`,
    `Last activity: ${handover.last_activity_at || "(unknown)"}`,
    "",
    "## Goal",
    handover.start_summary || "(no start summary recorded)",
    "",
    "## Current Summary",
    handover.rolling_summary || "(no rolling summary recorded)",
  ];
  if (handover.end_summary) {
    lines.push("", "## End Summary", handover.end_summary);
  }
  if (handover.decisions.length) {
    lines.push("", "## Decisions", ...handover.decisions.map((item) => `- ${item}`));
  }
  if (handover.files_touched.length) {
    lines.push("", "## Files / Artefacts", ...handover.files_touched.map((item) => `- ${item}`));
  }
  if (handover.commands_run.length) {
    lines.push("", "## Commands / Checks", ...handover.commands_run.map((item) => `- ${item}`));
  }
  if (handover.open_questions.length) {
    lines.push("", "## Open Questions", ...handover.open_questions.map((item) => `- ${item}`));
  }
  if (handover.next_steps.length) {
    lines.push(
      "",
      "## Next Steps",
      ...handover.next_steps.map((item, index) => `${index + 1}. ${item}`),
    );
  }
  lines.push(
    "",
    "## Boundaries",
    "- Treat this as session evidence, not automatically true durable memory.",
    "- Use The Librarian `remember`/`propose_memory` only for durable facts.",
  );
  return lines.join("\n");
}

function formatLocation(harness, sourceRef) {
  const h = harness || "(unknown)";
  if (sourceRef) return `${h} / ${sourceRef}`;
  return h;
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
    created_at: row.created_at,
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
    metadata: JSON.parse(row.metadata_json || "{}"),
  };
}

export function formatRecall(memories, heading = "Relevant Memories") {
  if (!memories.length) return `${heading}\n\nNo relevant memories found.`;
  return `${heading}\n\n${memories.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`;
}
