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
    related: { memory: Memory; ratio: number; isDuplicate: boolean; isConflict: boolean }[];
  };
  getMemory: (id: string) => Memory | null;
  listEvents: (filters?: Record<string, unknown>) => {
    events: MemoryEvent[];
    total: number;
    limit: number;
    offset: number;
  };
  searchMemories: (input?: Record<string, unknown>) => Memory[];
  detectRelated: (
    candidate: Memory,
    options?: { threshold?: number },
  ) => { duplicates: Memory[]; conflicts: Memory[] };
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) =>
    | { status: MemoryStatus.Active | MemoryStatus.Proposed; memory: Memory; duplicates: Memory[] }
    | { status: "conflict"; message: string; candidate: Memory; conflicts: Memory[] };
  updateMemory: (
    id: string,
    patch?: Record<string, unknown>,
    agent_id?: string,
    options?: { allowProtected?: boolean },
  ) => Memory | null;
  deleteMemory: (id: string, agent_id?: string) => Memory | null;
  verifyMemory: (id: string, result: string, note?: string, agent_id?: string) => Memory | null;
  recordRecall: (memories: Memory[], agent_id?: string, query?: string) => void;
  approveProposal: (
    id: string,
    action?: string,
    patch?: Record<string, unknown>,
    agent_id?: string,
  ) => Memory | null;
  resolveConflict: (input?: {
    memory_ids?: string[] | string;
    resolution?: string;
    explanation?: string;
    agent_id?: string;
    patch?: Record<string, unknown>;
  }) => Memory[];
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
    const active = memories.filter((m) => m.status !== MemoryStatus.Deleted);

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
        const isConflict = ratio >= 0.32 && seemsConflict(memory.body, other.body);
        return { memory: other, ratio, isDuplicate, isConflict };
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
        return { memory, score };
      })
      .filter((item) => item.score > 0);

    scored.sort(
      (a, b) => b.score - a.score || b.memory.updated_at.localeCompare(a.memory.updated_at),
    );
    return scored.slice(0, limit).map((item) => item.memory);
  }

  function detectRelated(candidate: Memory, options: { threshold?: number } = {}) {
    const terms = new Set(
      tokenize(`${candidate.title} ${candidate.body} ${candidate.tags.join(" ")}`),
    );
    if (!terms.size) return { duplicates: [], conflicts: [] };

    const pool = listAll({
      status: MemoryStatus.Active,
      agent_id: candidate.agent_id,
      project_key: candidate.project_key,
    }).filter((memory) => memory.id !== candidate.id && memory.category === candidate.category);

    const related = pool
      .map((memory) => {
        const other = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
        const overlap = [...terms].filter((term) => other.has(term)).length;
        const ratio = overlap / Math.max(terms.size, other.size, 1);
        return { memory, ratio };
      })
      .filter((item) => item.ratio >= (options.threshold || 0.32));

    const duplicates = related.filter((item) => item.ratio >= 0.55).map((item) => item.memory);
    const conflicts = related
      .filter((item) => item.ratio >= 0.32 && seemsConflict(candidate.body, item.memory.body))
      .map((item) => item.memory);

    return { duplicates, conflicts };
  }

  function createMemory(input: Record<string, unknown>, options: Record<string, unknown> = {}) {
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
    if (related.conflicts.length && !options.allowConflict) {
      appendEvent(
        MemoryEventType.ConflictDetected,
        {
          agent_id: memory.agent_id,
          candidate: memory,
          conflicts_with: related.conflicts.map((item) => item.id),
        },
        { memory_id: memory.id, agent_id: memory.agent_id },
      );
      return {
        status: "conflict" as const,
        message:
          "Potential conflicting memories found. Ask the agent or user to resolve before saving.",
        candidate: memory,
        conflicts: related.conflicts,
      };
    }

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
      throw new Error(
        "Memory status changes must use the dedicated approval, delete, archive, or conflict-resolution workflow.",
      );
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

  function deleteMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    appendEvent(MemoryEventType.Deleted, { memory_id: id, agent_id }, { memory_id: id, agent_id });
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

  function resolveConflict(
    input: {
      memory_ids?: string[] | string;
      resolution?: string;
      explanation?: string;
      agent_id?: string;
      patch?: Record<string, unknown>;
    } = {},
  ): Memory[] {
    const {
      memory_ids = [],
      resolution = "keep_both",
      explanation = "",
      agent_id = DEFAULT_AGENT_ID,
      patch = {},
    } = input;
    const ids = asArray(memory_ids);
    if (!ids.length) throw new Error("memory_ids is required");
    const results: Memory[] = [];
    for (const id of ids) {
      const existing = getMemory(id);
      if (!existing) continue;
      if (isProtectedCategory(existing.category)) {
        throw new Error(
          "Protected category conflicts require user approval through the dashboard.",
        );
      }
      let status: MemoryStatus = MemoryStatus.Active;
      const eventPatch = cleanPatch(patch);
      if (resolution === "archive") status = MemoryStatus.Archived;
      if (resolution === "keep_both") status = MemoryStatus.Active;
      if (resolution === "supersede" && id !== ids[0]) status = MemoryStatus.Archived;
      appendEvent(
        MemoryEventType.ConflictResolved,
        {
          memory_id: id,
          agent_id,
          resolution,
          explanation,
          status,
          patch: eventPatch,
        },
        { memory_id: id, agent_id },
      );
      const refreshed = getMemory(id);
      if (refreshed) results.push(refreshed);
    }
    return results;
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
    deleteMemory,
    verifyMemory,
    recordRecall,
    approveProposal,
    resolveConflict,
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

function seemsConflict(a: string, b: string): boolean {
  const left = normalizeString(a).toLowerCase();
  const right = normalizeString(b).toLowerCase();
  const negations = ["not", "never", "avoid", "prefer", "must", "should"];
  const sharedNegation = negations.some((word) => left.includes(word) && right.includes(word));
  const oppositeSignals =
    (left.includes("prefer") && right.includes("avoid")) ||
    (left.includes("avoid") && right.includes("prefer"));
  return oppositeSignals || sharedNegation;
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
