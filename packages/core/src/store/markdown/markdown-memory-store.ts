// Markdown-backed MemoryStore (plan 036 Phase 2) — built behind the
// existing interfaces, parity-first. This increment lands the write/read
// core (createMemory + getMemory); subsequent increments add list/search/
// update/archive/verify/approve toward the parity gate, after which it's
// wired behind `createLibrarianStore` (SQLite stays the default until the
// Phase-7 cutover).
//
// The store is SYNC (the storage-agnostic verb tests are sync): vault I/O
// is sync, and the git commit-per-op is an injected sync committer
// (`commit`) — most unit tests inject none (fast); production wires a
// synchronous git commit. Each memory is `memories/<id>.md`; status lives
// in frontmatter (folder-based inbox/consolidation filing is Phase 4).

import { makeId, normalizeMemoryInput, nowIso } from "../../constants.js";
import { MemoryStatus } from "../../schemas/common.js";
import type { Vault } from "../corpus/vault.js";
import { routeMemoryWrite } from "../memory-routing.js";
import type { Memory } from "../memory-store.js";
import { parseMemoryDocument, serializeMemoryDocument } from "./memory-doc.js";

export interface MarkdownMemoryStoreDeps {
  vault: Vault;
  /** Sync commit-per-op (e.g. a synchronous git commit). Omit to skip committing. */
  commit?: (message: string) => void;
  /** Clock injection (defaults to `nowIso`). */
  now?: () => string;
  /** Id generator injection (defaults to `makeId("mem")`). */
  generateId?: () => string;
}

function memoryPath(id: string): string {
  return `memories/${id}.md`;
}

const PRIORITY_RANK: Record<string, number> = { core: 0, high: 1, normal: 2 };
function priorityRank(memory: Memory): number {
  return PRIORITY_RANK[memory.priority] ?? 3;
}
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createMarkdownMemoryStore(deps: MarkdownMemoryStoreDeps) {
  const { vault } = deps;
  const now = deps.now ?? nowIso;
  const generateId = deps.generateId ?? (() => makeId("mem"));
  const commit = deps.commit ?? (() => {});

  function createMemory(input: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const normalized = normalizeMemoryInput(input);
    const { status, isGlobal, requiresApproval, curatorNote } = routeMemoryWrite(
      normalized.status,
      options,
    );
    const ts = now();
    // Only the fields the markdown model persists (D16 retired
    // category/visibility/scope) — keeps createMemory's returned memory
    // identical to a getMemory read-back.
    const memory: Memory = {
      id: generateId(),
      title: normalized.title,
      body: normalized.body,
      agent_id: normalized.agent_id,
      project_key: normalized.project_key || null,
      priority: normalized.priority,
      confidence: normalized.confidence,
      tags: normalized.tags,
      applies_to: normalized.applies_to,
      supersedes: [],
      conflicts_with: [],
      recall_count: 0,
      usefulness_score: 0,
      status,
      is_global: isGlobal,
      requires_approval: requiresApproval,
      created_at: ts,
      updated_at: ts,
      curator_note: curatorNote,
    };
    vault.writeText(memoryPath(memory.id), serializeMemoryDocument(memory));
    commit(`memory: ${status === MemoryStatus.Proposed ? "propose" : "store"} ${memory.id}`);
    return { status, memory, duplicates: [] as Memory[] };
  }

  function getMemory(id: string): Memory | null {
    const raw = vault.tryReadText(memoryPath(id));
    return raw ? parseMemoryDocument(raw) : null;
  }

  function readAllMemories(): Memory[] {
    return vault.listMarkdown("memories").map((rel) => parseMemoryDocument(vault.readText(rel)));
  }

  function listAll(filters: Record<string, unknown> = {}): Memory[] {
    let out = readAllMemories();
    if (filters.status) out = out.filter((m) => m.status === filters.status);
    if (filters.agent_id) out = out.filter((m) => m.agent_id === filters.agent_id);
    if (filters.project_key) {
      // Parity with SQLite `(project_key IS NULL OR project_key = ?)`.
      out = out.filter((m) => m.project_key == null || m.project_key === filters.project_key);
    }
    return out.sort(
      (a, b) => priorityRank(a) - priorityRank(b) || cmpStr(b.updated_at, a.updated_at),
    );
  }

  function listMemories(filters: Record<string, unknown> = {}) {
    let out = readAllMemories();
    if (filters.status) out = out.filter((m) => m.status === filters.status);
    if (filters.agent_id) out = out.filter((m) => m.agent_id === filters.agent_id);
    if (filters.project_key) {
      out = out.filter((m) => m.project_key == null || m.project_key === filters.project_key);
    }
    if (filters.is_global !== undefined) {
      out = out.filter((m) => m.is_global === Boolean(filters.is_global));
    }
    if (filters.requires_approval !== undefined) {
      out = out.filter((m) => m.requires_approval === Boolean(filters.requires_approval));
    }
    if (Array.isArray(filters.tags) && filters.tags.length > 0) {
      const wanted = filters.tags as string[];
      out = out.filter((m) => wanted.some((tag) => m.tags.includes(tag)));
    }
    if (filters.from) out = out.filter((m) => String(m.created_at) >= String(filters.from));
    if (filters.to) {
      // `to` is a date; SQLite compares against end-of-day.
      const ceiling = `${String(filters.to)}T23:59:59.999Z`;
      out = out.filter((m) => String(m.created_at) <= ceiling);
    }

    const total = out.length;
    const sortField = ["created_at", "updated_at", "title", "priority"].includes(
      filters.sort as string,
    )
      ? (filters.sort as string)
      : "updated_at";
    const asc = filters.order === "asc";
    out.sort((a, b) => {
      const cmp =
        sortField === "priority"
          ? priorityRank(a) - priorityRank(b)
          : cmpStr(String(a[sortField]), String(b[sortField]));
      return asc ? cmp : -cmp;
    });

    const limit = Math.min(Math.max(Number(filters.limit ?? 100), 1), 200);
    const offset = Math.max(Number(filters.offset ?? 0), 0);
    return { memories: out.slice(offset, offset + limit), total, limit, offset };
  }

  function getAggregates() {
    const active = listAll({}).filter((m) => m.status !== MemoryStatus.Archived);
    const tally = (field: string) => {
      const counts = new Map<unknown, number>();
      for (const memory of active) {
        const value = (memory as Record<string, unknown>)[field];
        if (!value) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, count }));
    };
    return {
      agents: tally("agent_id"),
      projects: tally("project_key"),
      // D16 / Section 4d.3 — category + scope columns retired.
      categories: [] as { value: unknown; count: number }[],
      statuses: tally("status"),
      scopes: [] as { value: unknown; count: number }[],
      priorities: tally("priority"),
      total: active.length,
    };
  }

  return { createMemory, getMemory, listAll, listMemories, getAggregates };
}
