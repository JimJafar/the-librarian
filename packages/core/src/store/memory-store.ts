// Memory store module — owns the memory CRUD surface of The Librarian.
//
// `createMemoryStore(deps)` returns the closure-based memory surface that
// `createLibrarianStore` spreads onto the public store object. Behavior
// must remain byte-identical to the pre-T3.3 implementation; the memory
// tests in tests/store/memory-store.test.ts pin the surface in place.
//
// Typing is intentionally loose for now (`Memory = Record<string, unknown>
// & { id: string }`). Tightening to the Zod-derived `Memory` from
// @librarian/core/schemas is a follow-up.

import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_AGENT_ID,
  asArray,
  isProtectedCategory,
  makeId,
  normalizeMemoryInput,
  normalizeString,
  nowIso,
} from "../constants.js";
import { Category, MemoryEventType, MemoryStatus, Visibility } from "../schemas/common.js";
import { appendJsonl, readJsonl } from "./jsonl.js";

// ---------- Public types ----------

export interface MemoryStoreDeps {
  db: DatabaseSync;
  eventsPath: string;
  rebuildMemoryIndex: () => void;
}

export type Memory = Record<string, unknown> & {
  id: string;
  agent_id: string;
  category: string;
  status: string;
  tags: string[];
  applies_to: string[];
  supersedes: string[];
  conflicts_with: string[];
  recall_count: number;
  usefulness_score: number;
  title: string;
  body: string;
  visibility: string;
  scope: string;
  priority: string;
  confidence: string;
  project_key?: string | null;
  updated_at: string;
};

export interface AppendMemoryEventOptions {
  memory_id?: string | null;
  agent_id?: string;
}

export interface MemoryEvent {
  event_id: string;
  event_type: string;
  memory_id: string | null;
  agent_id: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface MemoryStore {
  appendEvent: (
    eventType: string,
    payload?: Record<string, unknown>,
    options?: AppendMemoryEventOptions,
  ) => MemoryEvent;
  listAll: (filters?: Record<string, unknown>) => Memory[];
  listMemories: (filters?: Record<string, unknown>) => {
    memories: Memory[];
    total: number;
    limit: number;
    offset: number;
  };
  getAggregates: () => {
    agents: { value: unknown; count: number }[];
    projects: { value: unknown; count: number }[];
    categories: { value: unknown; count: number }[];
    statuses: { value: unknown; count: number }[];
    scopes: { value: unknown; count: number }[];
    priorities: { value: unknown; count: number }[];
    total: number;
  };
  getRelated: (id: string) => null | {
    memory: Memory;
    related: { memory: Memory; ratio: number; isDuplicate: boolean }[];
  };
  getMemory: (id: string) => Memory | null;
  listEvents: (filters?: Record<string, unknown>) => {
    events: MemoryEvent[];
    total: number;
    limit: number;
    offset: number;
  };
  searchMemories: (input?: Record<string, unknown>) => Memory[];
  detectRelated: (candidate: Memory, options?: { threshold?: number }) => { duplicates: Memory[] };
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    status: MemoryStatus.Active | MemoryStatus.Proposed;
    memory: Memory;
    duplicates: Memory[];
  };
  updateMemory: (
    id: string,
    patch?: Record<string, unknown>,
    agent_id?: string,
    options?: { allowProtected?: boolean },
  ) => Memory | null;
  bulkUpdateMemory: (input: {
    ids: string[];
    patch: { agent_id?: string; project_key?: string };
    agent_id?: string;
  }) => { transaction_id: string; updated: number };
  distinctValues: (input: { field: string; include_archived?: boolean }) => string[];
  archiveMemory: (id: string, agent_id?: string) => Memory | null;
  verifyMemory: (id: string, result: string, note?: string, agent_id?: string) => Memory | null;
  recordRecall: (memories: Memory[], agent_id?: string, query?: string) => void;
  approveProposal: (
    id: string,
    action?: string,
    patch?: Record<string, unknown>,
    agent_id?: string,
  ) => Memory | null;
  startContext: (input?: { agent_id?: string; project_key?: string; task_summary?: string }) => {
    memories: Memory[];
    text: string;
  };
}

// ---------- Factory ----------

export function createMemoryStore(deps: MemoryStoreDeps): MemoryStore {
  const { db, eventsPath, rebuildMemoryIndex } = deps;

  function appendEvent(
    eventType: string,
    payload: Record<string, unknown> = {},
    options: AppendMemoryEventOptions = {},
  ): MemoryEvent {
    const payloadMemory = (payload.memory as { id?: string; agent_id?: string } | undefined) || {};
    const event: MemoryEvent = {
      event_id: makeId("evt"),
      event_type: eventType,
      memory_id:
        options.memory_id || (payload.memory_id as string | null) || payloadMemory.id || null,
      agent_id:
        options.agent_id ||
        (payload.agent_id as string | undefined) ||
        payloadMemory.agent_id ||
        DEFAULT_AGENT_ID,
      created_at: nowIso(),
      payload,
    };
    appendJsonl(eventsPath, event);
    rebuildMemoryIndex();
    return event;
  }

  function listAll(filters: Record<string, unknown> = {}): Memory[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
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
    const sql = `SELECT * FROM memories ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY CASE priority WHEN 'core' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC`;
    return db
      .prepare(sql)
      .all(...(params as never[]))
      .map(rowToMemory);
  }

  function listMemories(filters: Record<string, unknown> = {}) {
    const clauses: string[] = [];
    const params: unknown[] = [];
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
    if (filters.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }
    if (filters.from) {
      clauses.push("created_at >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push("created_at <= ?");
      params.push(`${filters.to}T23:59:59.999Z`);
    }

    const sortField = ["created_at", "updated_at", "title", "priority"].includes(
      filters.sort as string,
    )
      ? (filters.sort as string)
      : "updated_at";
    const sortDir = filters.order === "asc" ? "ASC" : "DESC";
    const safeLimit = Math.min(Math.max(Number(filters.limit ?? 100), 1), 200);
    const safeOffset = Math.max(Number(filters.offset ?? 0), 0);

    const prioritySql =
      "CASE priority WHEN 'core' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
    const orderSql =
      sortField === "priority" ? `${prioritySql} ${sortDir}` : `${sortField} ${sortDir}`;
    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const total = (
      db
        .prepare(`SELECT COUNT(*) as n FROM memories ${whereClause}`)
        .get(...(params as never[])) as {
        n: number;
      }
    ).n;
    const memories = db
      .prepare(`SELECT * FROM memories ${whereClause} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
      .all(...(params as never[]), safeLimit, safeOffset)
      .map(rowToMemory);
    return { memories, total, limit: safeLimit, offset: safeOffset };
  }

  function getAggregates() {
    const memories = listAll({});
    const active = memories.filter((m) => m.status !== MemoryStatus.Archived);

    const tally = (field: string) => {
      const map = new Map<unknown, number>();
      for (const m of active) {
        const v = (m as Record<string, unknown>)[field];
        if (!v) continue;
        map.set(v, (map.get(v) ?? 0) + 1);
      }
      return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, count }));
    };

    return {
      agents: tally("agent_id"),
      projects: tally("project_key"),
      categories: tally("category"),
      statuses: tally("status"),
      scopes: tally("scope"),
      priorities: tally("priority"),
      total: active.length,
    };
  }

  function getMemory(id: string): Memory | null {
    const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? rowToMemory(row as Record<string, unknown>) : null;
  }

  function getRelated(id: string) {
    const memory = getMemory(id);
    if (!memory) return null;

    const terms = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
    if (!terms.size) return { memory, related: [] };

    const pool = listAll({
      status: MemoryStatus.Active,
      agent_id: memory.agent_id,
      project_key: memory.project_key,
    }).filter((m) => m.id !== id && m.category === memory.category);

    const related = pool
      .map((other) => {
        const otherTerms = new Set(
          tokenize(`${other.title} ${other.body} ${other.tags.join(" ")}`),
        );
        const overlap = [...terms].filter((t) => otherTerms.has(t)).length;
        const ratio = overlap / Math.max(terms.size, otherTerms.size, 1);
        const isDuplicate = ratio >= 0.55;
        return { memory: other, ratio, isDuplicate };
      })
      .filter((item) => item.ratio >= 0.32)
      .sort((a, b) => b.ratio - a.ratio);

    return { memory, related };
  }

  function listEvents(filters: Record<string, unknown> = {}) {
    const {
      type = "",
      agent_id = "",
      memory_id = "",
      result = "",
      query = "",
      limit = 25,
      offset = 0,
    } = filters as {
      type?: string;
      agent_id?: string;
      memory_id?: string;
      result?: string;
      query?: string;
      limit?: number;
      offset?: number;
    };
    const eventType = normalizeString(type);
    const agentId = normalizeString(agent_id);
    const memoryId = normalizeString(memory_id);
    const expectedResult = normalizeString(result);
    const searchQuery = normalizeString(query).toLowerCase();
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const filtered = readJsonl<MemoryEvent>(eventsPath)
      .filter((event) => {
        const payload = (event.payload || {}) as Record<string, unknown>;
        if (eventType && event.event_type !== eventType) return false;
        if (agentId && event.agent_id !== agentId) return false;
        if (memoryId && event.memory_id !== memoryId) return false;
        if (expectedResult && payload.result !== expectedResult) return false;
        if (searchQuery) {
          const payloadMemory = payload.memory as Record<string, unknown> | undefined;
          const payloadPatch = payload.patch as Record<string, unknown> | undefined;
          const haystack = [
            event.event_type,
            event.agent_id,
            event.memory_id,
            payload.query,
            payload.result,
            payload.note,
            payloadMemory?.title,
            payloadMemory?.body,
            payloadPatch?.title,
            payloadPatch?.body,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(searchQuery)) return false;
        }
        return true;
      })
      .reverse();

    return {
      events: filtered.slice(safeOffset, safeOffset + safeLimit),
      total: filtered.length,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  function searchMemories(input: Record<string, unknown> = {}): Memory[] {
    const {
      agent_id = DEFAULT_AGENT_ID,
      query = "",
      categories = [],
      project_key = "",
      include_private = true,
      limit = 8,
      status = MemoryStatus.Active,
    } = input as {
      agent_id?: string;
      query?: string;
      categories?: unknown;
      project_key?: string;
      include_private?: boolean;
      limit?: number;
      status?: string;
    };
    const cleaned = normalizeString(query);
    const categorySet = new Set(asArray(categories));
    const all = listAll({ status, agent_id: include_private ? agent_id : "", project_key });
    const allowed = all.filter((memory) => {
      if (categorySet.size && !categorySet.has(memory.category)) return false;
      if (
        memory.visibility === Visibility.AgentPrivate &&
        (!include_private || memory.agent_id !== agent_id)
      )
        return false;
      return true;
    });

    if (!cleaned) return allowed.slice(0, limit);

    const terms = tokenize(cleaned);
    const scored = allowed
      .map((memory) => {
        const haystack =
          `${memory.title} ${memory.body} ${memory.category} ${memory.tags.join(" ")} ${memory.project_key || ""}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) score += term.length > 4 ? 3 : 1;
        }
        if (memory.priority === "core") score += 3;
        if (memory.priority === "high") score += 1;
        if (memory.project_key && memory.project_key === project_key) score += 3;
        // Usefulness score (clamped ±3) sits in the same magnitude band as
        // priority + project match, so a maxed-out memory can compete with
        // a `core` one on recall sort.
        score += Math.max(-3, Math.min(3, Number(memory.usefulness_score || 0)));
        return { memory, score };
      })
      .filter((item) => item.score > 0);

    scored.sort(
      (a, b) => b.score - a.score || b.memory.updated_at.localeCompare(a.memory.updated_at),
    );
    return scored.slice(0, limit).map((item) => item.memory);
  }

  function detectRelated(candidate: Memory, options: { threshold?: number } = {}) {
    // Token-overlap similarity. Duplicates (ratio ≥ 0.55) surface as an
    // informational signal on createMemory so agents can decide to
    // consolidate; the old `conflicts` keyword heuristic was retired in
    // V1.2 because it produced too many false positives.
    const terms = new Set(
      tokenize(`${candidate.title} ${candidate.body} ${candidate.tags.join(" ")}`),
    );
    if (!terms.size) return { duplicates: [] };

    const pool = listAll({
      status: MemoryStatus.Active,
      agent_id: candidate.agent_id,
      project_key: candidate.project_key,
    }).filter((memory) => memory.id !== candidate.id && memory.category === candidate.category);

    const duplicates = pool
      .map((memory) => {
        const other = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
        const overlap = [...terms].filter((term) => other.has(term)).length;
        const ratio = overlap / Math.max(terms.size, other.size, 1);
        return { memory, ratio };
      })
      .filter((item) => item.ratio >= (options.threshold ?? 0.55))
      .map((item) => item.memory);

    return { duplicates };
  }

  function createMemory(input: Record<string, unknown>, options: Record<string, unknown> = {}) {
    // V1.2: createMemory always saves. The returned `duplicates` list is
    // informational — the agent can decide whether to consolidate via
    // update + verify(outdated). No more refused writes.
    const normalized = normalizeMemoryInput(input);
    const protectedWrite = isProtectedCategory(normalized.category) && !options.forceActive;
    const status =
      (options.status as MemoryStatus | undefined) ||
      (protectedWrite ? MemoryStatus.Proposed : normalized.status);
    const memory: Memory = {
      id: makeId("mem"),
      ...normalized,
      status,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_recalled_at: null,
      recall_count: 0,
      usefulness_score: 0,
      supersedes: [],
      conflicts_with: [],
    };

    const related = detectRelated(memory);
    appendEvent(
      status === MemoryStatus.Proposed ? MemoryEventType.Proposed : MemoryEventType.Created,
      { memory },
      { memory_id: memory.id, agent_id: memory.agent_id },
    );
    return {
      status: status as MemoryStatus.Active | MemoryStatus.Proposed,
      memory,
      duplicates: related.duplicates,
    };
  }

  function updateMemory(
    id: string,
    patch: Record<string, unknown> = {},
    agent_id: string = DEFAULT_AGENT_ID,
    options: { allowProtected?: boolean } = {},
  ): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (
      isProtectedCategory(existing.category) &&
      existing.status === MemoryStatus.Active &&
      !options.allowProtected
    ) {
      throw new Error("Protected memories must be changed through a proposal workflow.");
    }
    const normalizedPatch = cleanPatch(patch);
    if (normalizedPatch.status !== undefined && normalizedPatch.status !== existing.status) {
      throw new Error("Memory status changes must use the dedicated approval or archive workflow.");
    }
    if (
      normalizedPatch.category !== undefined &&
      normalizedPatch.category !== existing.category &&
      (isProtectedCategory(existing.category) ||
        isProtectedCategory(normalizedPatch.category as string)) &&
      !options.allowProtected
    ) {
      throw new Error(
        "Protected memory categories cannot be assigned or removed through update_memory.",
      );
    }
    appendEvent(
      MemoryEventType.Updated,
      { memory_id: id, agent_id, patch: normalizedPatch },
      { memory_id: id, agent_id },
    );
    return getMemory(id);
  }

  // D1.1 — bulk-update for the dashboard's re-home flow. Whitelists the
  // patch to `agent_id` + `project_key` so this can never become a
  // back-door for editing protected fields. Emits one
  // `memory.bulk_updated` ledger entry per id, all sharing the same
  // `transaction_id` so a future `bulkRevert` can find the set.
  function bulkUpdateMemory(input: {
    ids: string[];
    patch: { agent_id?: string; project_key?: string };
    agent_id?: string;
  }): { transaction_id: string; updated: number } {
    const callerAgent = input.agent_id || DEFAULT_AGENT_ID;
    const patch: Record<string, unknown> = {};
    if (input.patch.agent_id !== undefined) patch.agent_id = input.patch.agent_id;
    if (input.patch.project_key !== undefined) patch.project_key = input.patch.project_key;
    if (Object.keys(patch).length === 0) {
      throw new Error("bulkUpdateMemory requires at least one of agent_id / project_key in patch");
    }
    const transaction_id = makeId("txn");
    let updated = 0;
    for (const id of input.ids) {
      const existing = getMemory(id);
      if (!existing) continue;
      appendEvent(
        MemoryEventType.BulkUpdated,
        { memory_id: id, agent_id: callerAgent, patch, transaction_id },
        { memory_id: id, agent_id: callerAgent },
      );
      updated++;
    }
    return { transaction_id, updated };
  }

  // D1.1 — distinct-value lookup for the dashboard's data-driven filter
  // dropdowns. Whitelists the queryable columns to a known set so the
  // tRPC surface can't be coerced into a SELECT against arbitrary
  // columns. Default scope excludes archived memories so the dropdowns
  // don't surface stale agent ids / project keys.
  function distinctValues(input: { field: string; include_archived?: boolean }): string[] {
    // `memories` table has no `harness` column — harness is a session
    // concept. distinctValues stays scoped to the memory surface; sessions
    // get their own equivalent in D1.2.
    const allowed = new Set(["agent_id", "project_key", "category", "visibility"]);
    if (!allowed.has(input.field)) {
      throw new Error(`distinctValues field not allowed: ${input.field}`);
    }
    const includeArchived = input.include_archived === true;
    const where = includeArchived ? "" : `WHERE status != '${MemoryStatus.Archived}'`;
    const rows = db
      .prepare(
        `SELECT DISTINCT ${input.field} AS value FROM memories ${where} ORDER BY value COLLATE NOCASE`,
      )
      .all() as Array<{ value: string | null }>;
    return rows
      .map((r) => r.value)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  }

  function archiveMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    // V1.2 rename of the former `deleteMemory`. Emits `memory.archived`
    // directly (no more `memory.deleted` from new code) and sets status
    // to archived. Historical `memory.deleted` events keep projecting
    // to archived via the projection handler. Idempotent — already
    // archived rows short-circuit to avoid redundant ledger noise.
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status === MemoryStatus.Archived) return existing;
    appendEvent(MemoryEventType.Archived, { memory_id: id, agent_id }, { memory_id: id, agent_id });
    return getMemory(id);
  }

  function verifyMemory(
    id: string,
    result: string,
    note: string = "",
    agent_id: string = DEFAULT_AGENT_ID,
  ): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    appendEvent(
      MemoryEventType.Verified,
      { memory_id: id, agent_id, result, note },
      { memory_id: id, agent_id },
    );
    // Outdated is load-bearing — the agent saying "this memory is stale"
    // moves the row out of default recall by appending a paired archive
    // event. The verify event still records the verdict for audit.
    if (result === "outdated") {
      appendEvent(
        MemoryEventType.Archived,
        { memory_id: id, agent_id, reason: "verify_outdated" },
        { memory_id: id, agent_id },
      );
    }
    return getMemory(id);
  }

  function recordRecall(
    memories: Memory[],
    agent_id: string = DEFAULT_AGENT_ID,
    query: string = "",
  ): void {
    if (!memories.length) {
      appendEvent(
        MemoryEventType.RecallEmpty,
        { agent_id, query, returned_count: 0 },
        { agent_id },
      );
      return;
    }
    for (const memory of memories) {
      appendEvent(
        MemoryEventType.Recalled,
        { memory_id: memory.id, agent_id, query },
        { memory_id: memory.id, agent_id },
      );
    }
  }

  function approveProposal(
    id: string,
    action: string = "approve",
    patch: Record<string, unknown> = {},
    agent_id: string = DEFAULT_AGENT_ID,
  ): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status !== MemoryStatus.Proposed) throw new Error(`Memory ${id} is not proposed`);
    if (action === "reject") {
      appendEvent(
        MemoryEventType.Rejected,
        { memory_id: id, agent_id },
        { memory_id: id, agent_id },
      );
      return getMemory(id);
    }
    appendEvent(
      MemoryEventType.Approved,
      { memory_id: id, agent_id, patch: cleanPatch(patch) },
      { memory_id: id, agent_id },
    );
    return getMemory(id);
  }

  function startContext(
    input: { agent_id?: string; project_key?: string; task_summary?: string } = {},
  ) {
    const { agent_id = DEFAULT_AGENT_ID, project_key = "", task_summary = "" } = input;
    const identity = listAll({ status: MemoryStatus.Active, category: Category.Identity }).filter(
      (memory) => memory.visibility === Visibility.Common,
    );
    const relationship = listAll({
      status: MemoryStatus.Active,
      category: Category.Relationship,
    }).filter((memory) => memory.visibility === Visibility.Common);
    const privateMemories = searchMemories({
      agent_id,
      query: task_summary || project_key || agent_id,
      categories: [],
      project_key,
      include_private: true,
      limit: 6,
    }).filter(
      (memory) => memory.visibility === Visibility.AgentPrivate && memory.agent_id === agent_id,
    );

    const relevant =
      task_summary || project_key
        ? searchMemories({
            agent_id,
            query: `${task_summary} ${project_key}`,
            categories: [
              Category.Projects,
              Category.Environment,
              Category.Tools,
              Category.Lessons,
              Category.OpenThreads,
              Category.Preferences,
            ],
            project_key,
            include_private: true,
            limit: 8,
          }).filter(
            (memory) =>
              !([Category.Identity, Category.Relationship] as string[]).includes(memory.category),
          )
        : [];

    const memories = uniqueById([...identity, ...relationship, ...privateMemories, ...relevant]);
    recordRecall(memories, agent_id, task_summary || "start_context");
    return {
      memories,
      text: formatContextPackage({ identity, relationship, privateMemories, relevant }),
    };
  }

  return {
    appendEvent,
    listAll,
    listMemories,
    getAggregates,
    getRelated,
    getMemory,
    listEvents,
    searchMemories,
    detectRelated,
    createMemory,
    updateMemory,
    bulkUpdateMemory,
    distinctValues,
    archiveMemory,
    verifyMemory,
    recordRecall,
    approveProposal,
    startContext,
  };
}

// ---------- Helpers ----------

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    ...row,
    tags: JSON.parse((row.tags_json as string) || "[]"),
    applies_to: JSON.parse((row.applies_to_json as string) || "[]"),
    supersedes: JSON.parse((row.supersedes_json as string) || "[]"),
    conflicts_with: JSON.parse((row.conflicts_with_json as string) || "[]"),
    recall_count: Number(row.recall_count || 0),
    usefulness_score: Number(row.usefulness_score || 0),
  } as Memory;
}

function tokenize(text: string): string[] {
  return normalizeString(text)
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .filter(
      (term) =>
        !["the", "and", "for", "with", "that", "this", "from", "into", "agent", "memory"].includes(
          term,
        ),
    );
}

function cleanPatch(patch: Record<string, unknown> = {}): Record<string, unknown> {
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
    "tags",
  ];
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    if (patch[key] !== undefined)
      output[key] = Array.isArray(patch[key]) ? asArray(patch[key]) : patch[key];
  }
  return output;
}

function uniqueById(memories: Memory[]): Memory[] {
  const seen = new Set<string>();
  const output: Memory[] = [];
  for (const memory of memories) {
    if (!memory || seen.has(memory.id)) continue;
    seen.add(memory.id);
    output.push(memory);
  }
  return output;
}

function formatContextPackage({
  identity,
  relationship,
  privateMemories,
  relevant,
}: {
  identity: Memory[];
  relationship: Memory[];
  privateMemories: Memory[];
  relevant: Memory[];
}): string {
  const sections: string[] = [];
  sections.push("Memory Context");
  sections.push("");
  sections.push(formatSection("Identity", identity));
  sections.push(formatSection("Relationship", relationship));
  if (privateMemories.length)
    sections.push(formatSection("Agent Operating Notes", privateMemories));
  if (relevant.length) sections.push(formatSection("Relevant Working Context", relevant));
  return (
    sections.filter(Boolean).join("\n\n").trim() ||
    "Memory Context\n\nNo active memories found yet."
  );
}

function formatSection(title: string, memories: Memory[]): string {
  if (!memories.length) return `${title}\nNo active memories found.`;
  return `${title}\n${memories.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`;
}
