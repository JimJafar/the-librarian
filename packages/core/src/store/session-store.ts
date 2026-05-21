// Session store module — owns the session lifecycle surface of The Librarian.
//
// `createSessionStore(deps)` returns the closure-based session surface that
// `createLibrarianStore` spreads onto the public store object. Behavior
// must remain byte-identical to the pre-T3.4 implementation; the session
// tests in tests/store/session-store.test.ts pin the surface in place.
//
// Typing is intentionally loose for now (`Session = Record<string, unknown>
// & { id: string }`) to match the memory-store conventions. Tightening to
// the Zod-derived `Session` from @librarian/core/schemas is a follow-up.

import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_AGENT_ID,
  asArray,
  makeId,
  normalizeEnum,
  normalizeString,
  nowIso,
} from "../constants.js";
import { type HandoverPayload, renderHandover } from "../formatters/index.js";
import {
  SessionCaptureMode,
  SessionEventType,
  SessionPayloadType,
  SessionStatus,
  Visibility,
} from "../schemas/common.js";
import { appendJsonl } from "./jsonl.js";
import { applySessionEvent } from "./projection.js";

export type { HandoverPayload };

// ---------- Public types ----------

export type Session = Record<string, unknown> & {
  id: string;
  title: string;
  project_key: string | null;
  status: string;
  prior_status: string | null;
  visibility: string;
  created_by_agent_id: string;
  current_agent_id: string;
  created_in_harness: string | null;
  current_harness: string | null;
  source_ref: string | null;
  cwd: string | null;
  start_summary: string | null;
  rolling_summary: string | null;
  end_summary: string | null;
  next_steps: string[];
  tags: string[];
  capture_mode: string;
  started_at: string;
  updated_at: string;
  last_activity_at: string;
  paused_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  metadata: Record<string, unknown>;
};

export interface SessionEventRecord {
  id: string;
  session_id: string;
  type: string;
  agent_id: string | null;
  harness: string | null;
  source_ref: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AppendSessionEventOptions {
  session_id?: string | null;
  agent_id?: string;
  harness?: string | null;
  source_ref?: string | null;
}

export interface SessionEvent {
  event_id: string;
  event_type: SessionEventType;
  session_id: string | null;
  agent_id: string;
  harness: string | null;
  source_ref: string | null;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface PromoteMemoryResult {
  status: string;
  memory: { id: string; category: string; title: string } & Record<string, unknown>;
  duplicates?: unknown[] | undefined;
}

export interface PromoteSessionFactResult extends PromoteMemoryResult {
  session_id: string;
  session_event_id: string | null;
}

export interface SessionStoreDeps {
  db: DatabaseSync;
  sessionsPath: string;
  createMemory: (input: Record<string, unknown>) => PromoteMemoryResult;
}

export interface SessionStore {
  appendSessionEvent: (
    eventType: SessionEventType,
    payload?: Record<string, unknown>,
    options?: AppendSessionEventOptions,
  ) => SessionEvent;
  startSession: (input?: Record<string, unknown>) => { session: Session | null };
  getSession: (id: string) => Session | null;
  listSessions: (input?: Record<string, unknown>) => {
    sessions: Session[];
    total: number;
    limit: number;
  };
  recordSessionEvent: (input?: Record<string, unknown>) => SessionEvent;
  checkpointSession: (input?: Record<string, unknown>) => { session: Session | null };
  pauseSession: (input?: Record<string, unknown>) => { session: Session | null };
  endSession: (input?: Record<string, unknown>) => { session: Session | null };
  attachSession: (input?: Record<string, unknown>) => { session: Session | null };
  continueSession: (input?: Record<string, unknown>) => {
    session: Session;
    handover: HandoverPayload;
    text: string;
    format: string;
  };
  promoteSessionFact: (input?: Record<string, unknown>) => PromoteSessionFactResult;
  searchSessions: (input?: Record<string, unknown>) => {
    sessions: Session[];
    total: number;
    limit: number;
  };
  listSessionEvents: (input?: Record<string, unknown>) => {
    events: SessionEventRecord[];
    total: number;
    limit: number;
    offset: number;
  };
}

// ---------- Factory ----------

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const { db, sessionsPath, createMemory } = deps;

  function appendSessionEvent(
    eventType: SessionEventType,
    payload: Record<string, unknown> = {},
    options: AppendSessionEventOptions = {},
  ): SessionEvent {
    const payloadSession = (payload.session as { id?: string } | undefined) || {};
    const event: SessionEvent = {
      event_id: makeId("sevt"),
      event_type: eventType,
      session_id:
        options.session_id ||
        payloadSession.id ||
        (payload.session_id as string | undefined) ||
        null,
      agent_id: options.agent_id || (payload.agent_id as string | undefined) || DEFAULT_AGENT_ID,
      harness:
        options.harness !== undefined
          ? options.harness
          : ((payload.harness as string | null | undefined) ?? null),
      source_ref:
        options.source_ref !== undefined
          ? options.source_ref
          : ((payload.source_ref as string | null | undefined) ?? null),
      created_at: nowIso(),
      payload,
    };
    appendJsonl(sessionsPath, event);
    applySessionEvent(db, event);
    return event;
  }

  function startSession(input: Record<string, unknown> = {}): { session: Session | null } {
    const now = nowIso();
    const harness = normalizeString(input.harness) || null;
    const projectKey = normalizeString(input.project_key) || null;
    const agentId = normalizeString(input.agent_id, DEFAULT_AGENT_ID);
    const visibility = normalizeEnum(
      input.visibility,
      Object.values(Visibility),
      Visibility.Common,
    );
    const captureMode = normalizeEnum(
      input.capture_mode,
      Object.values(SessionCaptureMode),
      SessionCaptureMode.Summary,
    );
    const title =
      normalizeString(input.title) || `${projectKey || harness || "agent"} session @ ${now}`;

    const session: Session = {
      id: makeId("ses"),
      title,
      project_key: projectKey,
      status: SessionStatus.Active,
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
      metadata: isPlainObject(input.metadata) ? (input.metadata as Record<string, unknown>) : {},
    };

    appendSessionEvent(
      SessionEventType.Started,
      { session, agent_id: agentId },
      {
        session_id: session.id,
        agent_id: agentId,
        harness: session.current_harness,
        source_ref: session.source_ref,
      },
    );

    return { session: getSession(session.id) };
  }

  function getSession(id: string): Session | null {
    if (!id) return null;
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSession(row) : null;
  }

  function listSessions(input: Record<string, unknown> = {}) {
    const agentId = normalizeString(input.agent_id);
    const isAdmin = input.admin === true;
    const projectKey = normalizeString(input.project_key) || null;
    const sourceRef = normalizeString(input.source_ref) || null;
    const cwd = normalizeString(input.cwd) || null;
    const harness = normalizeString(input.harness) || null;
    const limit = Math.min(Math.max(Number(input.limit ?? 10), 1), 100);

    // S1.1: default list shows only active + paused. `include_ended` opts
    // ended sessions in. `include_archived` / `include_deleted` are still
    // accepted as inputs but treated as aliases for `include_ended` so
    // older callers don't break loudly during the transition.
    const requested = asArray(input.status);
    const statusSet = new Set<string>(
      requested.length ? requested : [SessionStatus.Active, SessionStatus.Paused],
    );
    if (input.include_ended || input.include_archived || input.include_deleted) {
      statusSet.add(SessionStatus.Ended);
    }
    const statuses = [...statusSet];

    if (!statuses.length) return { sessions: [], total: 0, limit };

    const placeholders = statuses.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM sessions WHERE status IN (${placeholders})`)
      .all(...(statuses as never[])) as Record<string, unknown>[];
    const sessions = rows.map(rowToSession);

    const visible = sessions.filter((session) => {
      if (isAdmin) return true;
      if (session.visibility === Visibility.Common) return true;
      return Boolean(agentId) && session.created_by_agent_id === agentId;
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
        -Date.parse(session.last_activity_at || session.started_at || "0"),
      ] as number[],
    }));

    scored.sort((a, b) => compareKeys(a.key, b.key));

    return {
      sessions: scored.slice(0, limit).map(({ session }) => session),
      total: scored.length,
      limit,
    };
  }

  function recordSessionEvent(input: Record<string, unknown> = {}): SessionEvent {
    const sessionId = normalizeString(input.session_id);
    const type = normalizeString(input.type);
    if (!(Object.values(SessionPayloadType) as string[]).includes(type)) {
      throw new Error(`Unknown session event payload type: ${type || "(empty)"}`);
    }
    const session = getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    assertSessionMutable(session, "record an event on");

    const agentId = normalizeString(
      input.agent_id,
      (session.current_agent_id as string) || DEFAULT_AGENT_ID,
    );
    const harness = normalizeString(input.harness) || session.current_harness || null;
    const sourceRef = normalizeString(input.source_ref) || session.source_ref || null;
    const summary = normalizeString(input.summary);
    const extra = isPlainObject(input.payload) ? (input.payload as Record<string, unknown>) : {};

    const payload: Record<string, unknown> = {
      type,
      summary,
      agent_id: agentId,
      ...extra,
    };

    return appendSessionEvent(SessionEventType.EventRecorded, payload, {
      session_id: sessionId,
      agent_id: agentId,
      harness,
      source_ref: sourceRef,
    });
  }

  function checkpointSession(input: Record<string, unknown> = {}) {
    return lifecycleEvent(SessionEventType.Checkpointed, input, "checkpoint");
  }

  function pauseSession(input: Record<string, unknown> = {}) {
    return lifecycleEvent(SessionEventType.Paused, input, "pause");
  }

  function endSession(input: Record<string, unknown> = {}) {
    return lifecycleEvent(SessionEventType.Ended, input, "end");
  }

  function attachSession(input: Record<string, unknown> = {}): { session: Session | null } {
    const sessionId = normalizeString(input.session_id);
    const session = getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    assertSessionMutable(session, "attach");

    const agentId = normalizeString(
      input.agent_id,
      (session.current_agent_id as string) || DEFAULT_AGENT_ID,
    );
    const harness = normalizeString(input.harness) || session.current_harness || null;
    const sourceRef = normalizeString(input.source_ref) || session.source_ref || null;
    const cwd = normalizeString(input.cwd) || session.cwd || null;

    appendSessionEvent(
      SessionEventType.AttachedToHarness,
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

    return { session: getSession(sessionId) };
  }

  function continueSession(input: Record<string, unknown> = {}) {
    const sessionId = normalizeString(input.session_id);
    const session = getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);

    const attach = input.attach !== false;
    const targetHarness = normalizeString(input.target_harness) || null;
    const targetSourceRef = normalizeString(input.target_source_ref) || null;
    const targetCwd = normalizeString(input.target_cwd) || null;
    const format = normalizeString(input.format) || "prose";
    const agentId = normalizeString(
      input.agent_id,
      (session.current_agent_id as string) || DEFAULT_AGENT_ID,
    );

    const wantsHarnessSwap = targetHarness && targetHarness !== session.current_harness;
    const wantsSourceSwap = targetSourceRef && targetSourceRef !== session.source_ref;
    // S1.1: continuing an ended session implicitly resumes it. Force an
    // attach event so the projection flips status: ended → paused, even
    // when the caller didn't request a harness swap.
    const isResume = session.status === SessionStatus.Ended;
    const shouldAttach = attach && (wantsHarnessSwap || wantsSourceSwap || isResume);

    let working: Session = session;
    if (shouldAttach) {
      const attached = attachSession({
        session_id: sessionId,
        agent_id: agentId,
        harness: targetHarness || session.current_harness,
        source_ref: targetSourceRef || session.source_ref,
        cwd: targetCwd || session.cwd,
      });
      working = attached.session || session;
    }

    const original = getOriginalSessionSnapshot(sessionId) || session;
    const aggregates = aggregateHandoverInputs(sessionId);

    const handover: HandoverPayload = {
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

  function getOriginalSessionSnapshot(sessionId: string): Session | null {
    const row = db
      .prepare(
        `SELECT payload_json FROM session_events WHERE session_id = ? AND type = 'started' ORDER BY created_at ASC LIMIT 1`,
      )
      .get(sessionId) as { payload_json?: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json || "{}") as { session?: Session };
    return payload.session || null;
  }

  function aggregateHandoverInputs(sessionId: string): {
    decisions: string[];
    files: string[];
    commands: string[];
    questions: string[];
  } {
    const rows = db
      .prepare(
        `SELECT type, payload_json FROM session_events WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId) as { type: string; payload_json?: string }[];
    // `row.type` is the short form stored in session_events. For payload
    // events it equals the SessionPayloadType value; for lifecycle events
    // it equals the SessionEventType value minus the "session." prefix
    // (see projection.ts shortType).
    const LIFECYCLE_SHORT_TYPES = new Set(
      [SessionEventType.Checkpointed, SessionEventType.Paused, SessionEventType.Ended].map((t) =>
        t.slice("session.".length),
      ),
    );
    const decisions: string[] = [];
    const files: string[] = [];
    const commands: string[] = [];
    const questions: string[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json || "{}") as Record<string, unknown>;
      const summary = payload.summary as string | undefined;
      if (row.type === SessionPayloadType.Decision && summary) decisions.push(summary);
      if (row.type === SessionPayloadType.File && summary) files.push(summary);
      if (row.type === SessionPayloadType.Command && summary) commands.push(summary);
      if (row.type === SessionPayloadType.Question && summary) questions.push(summary);
      if (LIFECYCLE_SHORT_TYPES.has(row.type)) {
        for (const d of asArray(payload.decisions)) decisions.push(d);
        for (const f of asArray(payload.files_touched)) files.push(f);
        for (const c of asArray(payload.commands_run)) commands.push(c);
        for (const q of asArray(payload.open_questions)) questions.push(q);
      }
    }
    return { decisions, files, commands, questions };
  }

  function lifecycleEvent(
    eventType: SessionEventType,
    input: Record<string, unknown>,
    action: string,
  ): { session: Session | null } {
    const sessionId = normalizeString(input.session_id);
    const session = getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);
    assertSessionMutable(session, action);

    const agentId = normalizeString(
      input.agent_id,
      (session.current_agent_id as string) || DEFAULT_AGENT_ID,
    );
    const harness = normalizeString(input.harness) || session.current_harness || null;
    const sourceRef = normalizeString(input.source_ref) || session.source_ref || null;
    const summary = normalizeString(input.summary);

    const payload: Record<string, unknown> = {
      summary,
      agent_id: agentId,
      decisions: asArray(input.decisions),
      files_touched: asArray(input.files_touched),
      commands_run: asArray(input.commands_run),
      open_questions: asArray(input.open_questions),
      next_steps: asArray(input.next_steps),
    };
    if (eventType === SessionEventType.Ended && Array.isArray(input.candidate_memories)) {
      payload.candidate_memories = input.candidate_memories;
    }

    appendSessionEvent(eventType, payload, {
      session_id: sessionId,
      agent_id: agentId,
      harness,
      source_ref: sourceRef,
    });

    return { session: getSession(sessionId) };
  }

  function promoteSessionFact(input: Record<string, unknown> = {}): PromoteSessionFactResult {
    const sessionId = normalizeString(input.session_id);
    const session = getSession(sessionId);
    if (!session) throw new Error(`No session found for id ${sessionId}`);

    const memoryInput = (input.memory as Record<string, unknown>) || {};
    const hasContent =
      normalizeString(memoryInput.title) ||
      normalizeString(memoryInput.body) ||
      normalizeString(memoryInput.content);
    if (!hasContent) {
      throw new Error("promote_session_fact requires a memory with a title or body.");
    }

    const agentId = normalizeString(
      input.agent_id,
      (session.current_agent_id as string) || DEFAULT_AGENT_ID,
    );
    const sessionEventId = normalizeString(input.session_event_id) || null;

    const memoryResult = createMemory({
      ...memoryInput,
      agent_id: memoryInput.agent_id || agentId,
    });

    const memory = memoryResult.memory;
    appendSessionEvent(
      SessionEventType.PromotedToMemory,
      {
        agent_id: agentId,
        memory_id: memory.id,
        session_event_id: sessionEventId,
        memory_status: memoryResult.status,
        memory_category: memory.category,
        title: memory.title,
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
      memory,
      duplicates: memoryResult.duplicates || [],
      session_id: sessionId,
      session_event_id: sessionEventId,
    };
  }

  function searchSessions(input: Record<string, unknown> = {}) {
    const query = normalizeString(input.query);
    const agentId = normalizeString(input.agent_id);
    const isAdmin = input.admin === true;
    const projectKey = normalizeString(input.project_key) || null;
    // S1.1: `include_archived` / `include_deleted` are aliases for the
    // new `include_ended` flag during the migration.
    const includeEnded =
      input.include_ended === true ||
      input.include_archived === true ||
      input.include_deleted === true;
    const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 50);

    if (!query) return { sessions: [], total: 0, limit };

    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return { sessions: [], total: 0, limit };

    let matchedIds: string[];
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT session_id FROM session_events_fts WHERE session_events_fts MATCH ?`,
        )
        .all(ftsQuery) as { session_id: string | null }[];
      matchedIds = rows.map((row) => row.session_id).filter((id): id is string => Boolean(id));
    } catch {
      return { sessions: [], total: 0, limit };
    }

    if (!matchedIds.length) return { sessions: [], total: 0, limit };

    const placeholders = matchedIds.map(() => "?").join(", ");
    const sessions = (
      db
        .prepare(`SELECT * FROM sessions WHERE id IN (${placeholders})`)
        .all(...(matchedIds as never[])) as Record<string, unknown>[]
    ).map(rowToSession);

    const filtered = sessions.filter((session) => {
      if (!includeEnded && session.status === SessionStatus.Ended) return false;
      if (
        !isAdmin &&
        session.visibility === Visibility.AgentPrivate &&
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

  function listSessionEvents(input: Record<string, unknown> = {}) {
    const sessionId = normalizeString(input.session_id);
    const type = normalizeString(input.type);
    const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
    const offset = Math.max(Number(input.offset ?? 0), 0);

    const clauses = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    const whereSql = `WHERE ${clauses.join(" AND ")}`;
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM session_events ${whereSql}`)
        .get(...(params as never[])) as { n: number }
    ).n;
    const rows = db
      .prepare(
        `SELECT * FROM session_events ${whereSql} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[]), limit, offset) as Record<string, unknown>[];

    return {
      events: rows.map(rowToSessionEvent),
      total,
      limit,
      offset,
    };
  }

  return {
    appendSessionEvent,
    startSession,
    getSession,
    listSessions,
    recordSessionEvent,
    checkpointSession,
    pauseSession,
    endSession,
    attachSession,
    continueSession,
    promoteSessionFact,
    searchSessions,
    listSessionEvents,
  };
}

// ---------- Module-private helpers ----------

function assertSessionMutable(session: Session, action: string): void {
  // S1.1 allows `ended` here — resume / continue / record-event all
  // transition the session back to `active` or `paused`. The function is
  // kept so a future immutable state (e.g. a hard-purge flag) can land
  // without rewiring every caller.
  void session;
  void action;
}

function statusPriority(status: string): number {
  if (status === SessionStatus.Active) return 0;
  if (status === SessionStatus.Paused) return 1;
  if (status === SessionStatus.Ended) return 2;
  return 3;
}

function sourceMatches(session: Session, sourceRef: string | null, cwd: string | null): boolean {
  if (sourceRef && session.source_ref === sourceRef) return true;
  if (cwd && session.cwd === cwd) return true;
  return false;
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFtsQuery(query: string): string {
  const tokens = String(query)
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (!tokens.length) return "";
  return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" ");
}

// ---------- Row mappers ----------

function rowToSessionEvent(row: Record<string, unknown>): SessionEventRecord {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    type: row.type as string,
    agent_id: (row.agent_id as string | null) ?? null,
    harness: (row.harness as string | null) ?? null,
    source_ref: (row.source_ref as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    payload: JSON.parse((row.payload_json as string) || "{}") as Record<string, unknown>,
    created_at: row.created_at as string,
  };
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    project_key: (row.project_key as string | null) ?? null,
    status: row.status as string,
    prior_status: (row.prior_status as string | null) ?? null,
    visibility: row.visibility as string,
    created_by_agent_id: row.created_by_agent_id as string,
    current_agent_id: row.current_agent_id as string,
    created_in_harness: (row.created_in_harness as string | null) ?? null,
    current_harness: (row.current_harness as string | null) ?? null,
    source_ref: (row.source_ref as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    start_summary: (row.start_summary as string | null) ?? null,
    rolling_summary: (row.rolling_summary as string | null) ?? null,
    end_summary: (row.end_summary as string | null) ?? null,
    next_steps: JSON.parse((row.next_steps_json as string) || "[]") as string[],
    tags: JSON.parse((row.tags_json as string) || "[]") as string[],
    capture_mode: row.capture_mode as string,
    started_at: row.started_at as string,
    updated_at: row.updated_at as string,
    last_activity_at: row.last_activity_at as string,
    paused_at: (row.paused_at as string | null) ?? null,
    ended_at: (row.ended_at as string | null) ?? null,
    archived_at: (row.archived_at as string | null) ?? null,
    deleted_at: (row.deleted_at as string | null) ?? null,
    metadata: JSON.parse((row.metadata_json as string) || "{}") as Record<string, unknown>,
  };
}
