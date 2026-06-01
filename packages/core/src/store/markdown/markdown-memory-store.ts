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

import {
  DEFAULT_AGENT_ID,
  asArray,
  makeId,
  normalizeMemoryInput,
  normalizeString,
  nowIso,
} from "../../constants.js";
import { MemoryStatus, VerifyResult } from "../../schemas/common.js";
import type { Vault } from "../corpus/vault.js";
import { cleanPatch } from "../memory-patch.js";
import { routeMemoryWrite } from "../memory-routing.js";
import type { Memory } from "../memory-store.js";
import { tokenize } from "../memory-tokenize.js";
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
    const related = detectRelated(memory);
    vault.writeText(memoryPath(memory.id), serializeMemoryDocument(memory));
    commit(`memory: ${status === MemoryStatus.Proposed ? "propose" : "store"} ${memory.id}`);
    return { status, memory, duplicates: related.duplicates };
  }

  function getMemory(id: string): Memory | null {
    const raw = vault.tryReadText(memoryPath(id));
    return raw ? parseMemoryDocument(raw) : null;
  }

  // Write a mutated memory back + commit. The state-transition logic below
  // mirrors the SQLite projection's reduceMemoryLog handlers (which the
  // SQLite store reaches via events); the markdown store applies them
  // directly to the document.
  function persist(memory: Memory, message: string): Memory {
    vault.writeText(memoryPath(memory.id), serializeMemoryDocument(memory));
    commit(message);
    return memory;
  }

  function updateMemory(
    id: string,
    patch: Record<string, unknown> = {},
    agent_id: string = DEFAULT_AGENT_ID,
    options: { allowProtected?: boolean } = {},
  ): Memory | null {
    void agent_id;
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (
      existing.requires_approval === true &&
      existing.status === MemoryStatus.Active &&
      !options.allowProtected
    ) {
      throw new Error("Protected memories must be changed through a proposal workflow.");
    }
    const normalizedPatch = cleanPatch(patch);
    if (normalizedPatch.status !== undefined && normalizedPatch.status !== existing.status) {
      throw new Error("Memory status changes must use the dedicated approval or archive workflow.");
    }
    return persist(
      { ...existing, ...normalizedPatch, id, updated_at: now() },
      `memory: update ${id}`,
    );
  }

  function archiveMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    void agent_id;
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status === MemoryStatus.Archived) return existing; // idempotent
    return persist(
      { ...existing, status: MemoryStatus.Archived, updated_at: now() },
      `memory: archive ${id}`,
    );
  }

  function verifyMemory(
    id: string,
    result: string,
    note: string = "",
    agent_id: string = DEFAULT_AGENT_ID,
  ): Memory | null {
    void note;
    void agent_id;
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    // useful → +1, not_useful / legacy "wrong" → −1, outdated → 0 (clamped ±3).
    const delta =
      result === VerifyResult.Useful
        ? 1
        : result === VerifyResult.NotUseful || result === "wrong"
          ? -1
          : 0;
    const usefulness_score = Math.max(
      -3,
      Math.min(3, Number(existing.usefulness_score || 0) + delta),
    );
    // outdated is load-bearing — it also archives the memory out of recall.
    const status =
      result === VerifyResult.Outdated ? MemoryStatus.Archived : (existing.status as MemoryStatus);
    return persist(
      { ...existing, usefulness_score, status, updated_at: now() },
      `memory: verify ${id}`,
    );
  }

  function approveProposal(
    id: string,
    action: string = "approve",
    patch: Record<string, unknown> = {},
    agent_id: string = DEFAULT_AGENT_ID,
  ): Memory | null {
    void agent_id;
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status !== MemoryStatus.Proposed) throw new Error(`Memory ${id} is not proposed`);
    if (action === "reject") {
      return persist(
        { ...existing, status: MemoryStatus.Archived, updated_at: now() },
        `memory: reject ${id}`,
      );
    }
    return persist(
      { ...existing, ...cleanPatch(patch), status: MemoryStatus.Active, updated_at: now() },
      `memory: approve ${id}`,
    );
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

  function searchMemories(input: Record<string, unknown> = {}): Memory[] {
    const query = typeof input.query === "string" ? input.query : "";
    const projectKey = typeof input.project_key === "string" ? input.project_key : "";
    const limit = typeof input.limit === "number" ? input.limit : 8;
    const status = (input.status as string | undefined) ?? MemoryStatus.Active;
    const cleaned = normalizeString(query);
    const tagSet = new Set(asArray(input.tags));

    const allowed = listAll({ status, project_key: projectKey }).filter((memory) => {
      if (!tagSet.size) return true;
      return (memory.tags || []).some((tag) => tagSet.has(tag));
    });
    if (!cleaned) return allowed.slice(0, limit);

    const terms = tokenize(cleaned);
    const scored = allowed
      .map((memory) => {
        const haystack =
          `${memory.title} ${memory.body} ${memory.tags.join(" ")} ${memory.project_key || ""}`.toLowerCase();
        let score = 0;
        for (const term of terms) if (haystack.includes(term)) score += term.length > 4 ? 3 : 1;
        if (memory.priority === "core") score += 3;
        if (memory.priority === "high") score += 1;
        if (memory.project_key && memory.project_key === projectKey) score += 3;
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
    const terms = new Set(
      tokenize(`${candidate.title} ${candidate.body} ${candidate.tags.join(" ")}`),
    );
    if (!terms.size) return { duplicates: [] as Memory[] };
    const pool = listAll({
      status: MemoryStatus.Active,
      agent_id: candidate.agent_id,
      project_key: candidate.project_key ?? undefined,
    }).filter((memory) => memory.id !== candidate.id);
    const duplicates = pool
      .map((memory) => {
        const other = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
        const overlap = [...terms].filter((term) => other.has(term)).length;
        return { memory, ratio: overlap / Math.max(terms.size, other.size, 1) };
      })
      .filter((item) => item.ratio >= (options.threshold ?? 0.55))
      .map((item) => item.memory);
    return { duplicates };
  }

  function getRelated(id: string) {
    const memory = getMemory(id);
    if (!memory) return null;
    const terms = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
    if (!terms.size) return { memory, related: [] };
    const pool = listAll({
      status: MemoryStatus.Active,
      agent_id: memory.agent_id,
      project_key: memory.project_key ?? undefined,
    }).filter((other) => other.id !== id);
    const related = pool
      .map((other) => {
        const otherTerms = new Set(
          tokenize(`${other.title} ${other.body} ${other.tags.join(" ")}`),
        );
        const overlap = [...terms].filter((term) => otherTerms.has(term)).length;
        const ratio = overlap / Math.max(terms.size, otherTerms.size, 1);
        return { memory: other, ratio, isDuplicate: ratio >= 0.55 };
      })
      .filter((item) => item.ratio >= 0.32)
      .sort((a, b) => b.ratio - a.ratio);
    return { memory, related };
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

  return {
    createMemory,
    getMemory,
    listAll,
    listMemories,
    getAggregates,
    searchMemories,
    detectRelated,
    getRelated,
    updateMemory,
    archiveMemory,
    verifyMemory,
    approveProposal,
  };
}
