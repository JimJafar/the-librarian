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
// synchronous git commit. Each memory is a human-readable
// `memories/<title-slug>-<shortid>.md` (resolved back to a memory by its
// frontmatter id); status lives in frontmatter (folder-based inbox/intake
// filing is Phase 4).

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
import { formatContextPackage, uniqueById } from "../memory-context.js";
import { cleanPatch } from "../memory-patch.js";
import { routeMemoryWrite } from "../memory-routing.js";
import type { Memory, MemoryEvent, MemoryStore } from "../memory-store.js";
import { tokenize } from "../memory-tokenize.js";
import { parseMemoryDocument, serializeMemoryDocument } from "./memory-doc.js";

export interface MarkdownMemoryStoreDeps {
  vault: Vault;
  /** Sync commit-per-op (e.g. a synchronous git commit). Omit to skip committing. */
  commit?: (message: string) => void;
  /** Fired after every successful write (post-commit) — e.g. to invalidate a disposable index cache. */
  onWrite?: () => void;
  /** Clock injection (defaults to `nowIso`). */
  now?: () => string;
  /** Id generator injection (defaults to `makeId("mem")`). */
  generateId?: () => string;
}

const SLUG_MAX = 60;

/** A human-readable, filesystem-safe slug from a memory title (ASCII kebab-case). */
function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop accents (é → e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics → one hyphen
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, ""); // a hyphen left dangling by the slice
  return slug || "memory"; // symbol-only / empty titles still get a name
}

/** A short, stable id fragment that makes the filename unique + greppable. */
function shortId(id: string): string {
  const core = id.replace(/^mem_/, "").replace(/[^a-z0-9]/gi, "");
  return core.slice(0, 8) || id;
}

/**
 * Human-readable memory filename: `memories/<title-slug>-<shortid>.md`. The id
 * suffix guarantees uniqueness (no collision logic needed) and keeps the id
 * greppable. The name is set once at creation and never changes — the frontmatter
 * id + title are authoritative — so id→path lookups resolve by scanning ids, not
 * by recomputing the path from a (possibly changed) title.
 */
function memoryFileName(memory: { id: string; title: string }): string {
  return `memories/${slugify(memory.title)}-${shortId(memory.id)}.md`;
}

const PRIORITY_RANK: Record<string, number> = { core: 0, high: 1, normal: 2 };
function priorityRank(memory: Memory): number {
  return PRIORITY_RANK[memory.priority] ?? 3;
}
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const LEDGER_RETIRED =
  "event ledger is retired in the markdown backend — git history is the audit trail";

export function createMarkdownMemoryStore(deps: MarkdownMemoryStoreDeps): MemoryStore {
  const { vault } = deps;
  const now = deps.now ?? nowIso;
  const generateId = deps.generateId ?? (() => makeId("mem"));
  const rawCommit = deps.commit ?? (() => {});
  // Wrap commit so every write fires onWrite — one hook covering all mutations
  // (createMemory + persist, used by update/archive/verify), e.g. to invalidate
  // the disposable recall index.
  const commit = (message: string): void => {
    rawCommit(message);
    deps.onWrite?.();
  };

  // id → relative path. Filenames are human-readable slugs (memoryFileName), so
  // reads + write-backs resolve a memory's file by its frontmatter id rather than
  // computing the path. Built lazily by scanning memories/, kept current as we
  // create, and rescanned once on a miss (the vault is git-backed + hand-editable,
  // and pre-slug `<id>.md` files must still resolve).
  let idToPath: Map<string, string> | null = null;
  function scanIdToPath(): Map<string, string> {
    const map = new Map<string, string>();
    for (const rel of vault.listMarkdown("memories")) {
      try {
        map.set(parseMemoryDocument(vault.readText(rel)).id, rel);
      } catch {
        // a hand-edited / foreign .md that doesn't parse is just not
        // id-addressable (fail-soft, mirrors buildCorpusIndex).
      }
    }
    return map;
  }
  function pathForId(id: string): string | null {
    idToPath ??= scanIdToPath();
    const hit = idToPath.get(id);
    if (hit) return hit;
    idToPath = scanIdToPath(); // miss → maybe written outside the store; rescan once
    return idToPath.get(id) ?? null;
  }

  // The append-only event ledger is retired in the markdown model — every
  // write is a git commit, so git history is the audit trail. These two
  // members exist only to satisfy the `MemoryStore` interface; nothing on
  // the markdown write path calls them, and the SQLite-era ledger consumers
  // (dashboard logs view, etc.) are rewired to git history at the Phase-7
  // cutover. They fail loudly so a stray ledger dependency surfaces.
  function appendEvent(): MemoryEvent {
    throw new Error(LEDGER_RETIRED);
  }
  function listEvents(): { events: MemoryEvent[]; total: number; limit: number; offset: number } {
    throw new Error(LEDGER_RETIRED);
  }

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
      flags: [],
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
    // Human-readable filename; the id suffix keeps it unique, but guard against
    // the astronomically rare same-slug + same-fragment clash so we never
    // silently overwrite a different memory.
    let rel = memoryFileName(memory);
    if (vault.exists(rel))
      rel = `memories/${slugify(memory.title)}-${memory.id.replace(/^mem_/, "")}.md`;
    vault.writeText(rel, serializeMemoryDocument(memory));
    idToPath?.set(memory.id, rel); // keep the resolver cache current
    commit(`memory: ${status === MemoryStatus.Proposed ? "propose" : "store"} ${memory.id}`);
    // Narrow to the interface's active|proposed return shape — the same cast
    // the SQLite createMemory makes over the identical normalize+route
    // pipeline. (A caller force-passing options.status: "archived" is the lone
    // edge, shared with SQLite; real callers pass nothing or "proposed".)
    return {
      status: status as MemoryStatus.Active | MemoryStatus.Proposed,
      memory,
      duplicates: related.duplicates,
    };
  }

  function getMemory(id: string): Memory | null {
    const rel = pathForId(id);
    if (rel === null) return null;
    const raw = vault.tryReadText(rel);
    return raw ? parseMemoryDocument(raw) : null;
  }

  // Write a mutated memory back + commit. The state-transition logic below
  // mirrors the SQLite projection's reduceMemoryLog handlers (which the
  // SQLite store reaches via events); the markdown store applies them
  // directly to the document.
  function persist(memory: Memory, message: string): Memory {
    // Write back to the existing file (resolved by id) so the filename stays
    // stable across updates/retitles; fall back to a fresh name if somehow absent.
    const rel = pathForId(memory.id) ?? memoryFileName(memory);
    vault.writeText(rel, serializeMemoryDocument(memory));
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

  // The narrow inverse of archiveMemory (spec 044 D-5b): restore an archived
  // memory to Active. Used by the admin `unmerge` mutation to un-archive the
  // sources a bad merge collapsed. Mirrors archiveMemory's shape exactly —
  // status transition + updated_at + commit — and is idempotent (an
  // already-active memory is returned unchanged, no commit).
  function unarchiveMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    void agent_id;
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status === MemoryStatus.Active) return existing; // idempotent
    return persist(
      { ...existing, status: MemoryStatus.Active, updated_at: now() },
      `memory: unarchive ${id}`,
    );
  }

  // Permanently delete an ARCHIVED memory: hard-delete its vault document (the
  // narrow archive=move exception) and commit. The disposable index rebuilds
  // from the vault on the next read, so the row drops automatically — no
  // separate index delete. Guarded to archived-only so a one-click destroy can
  // never hit a live (active/proposed) memory: archive it first. Idempotent —
  // purging an already-absent memory is a no-op returning null. The deletion is
  // a git commit, so an admin can still recover it from history.
  function purgeMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    void agent_id;
    const existing = getMemory(id);
    if (!existing) return null; // already gone — idempotent no-op
    if (existing.status !== MemoryStatus.Archived) {
      throw new Error(
        `Memory ${id} is ${existing.status}, not archived — only archived memories can be permanently deleted. Archive it first.`,
      );
    }
    const rel = pathForId(id);
    if (rel) vault.removeFile(rel);
    idToPath?.delete(id); // keep the resolver cache current
    commit(`memory: purge ${id}`);
    return existing;
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
      statuses: tally("status"),
      priorities: tally("priority"),
      total: active.length,
    };
  }

  function recordRecall(_memories: Memory[], _agentId?: string, _query?: string): void {
    // No-op in the markdown model: recall-count tracking + the recall event
    // ledger are retired (D16 — relevance comes from the index, not usage
    // counters; git history replaces the ledger). Kept for interface parity.
  }

  function bulkUpdateMemory(input: {
    ids: string[];
    patch: { agent_id?: string; project_key?: string };
    agent_id?: string;
  }): { transaction_id: string; updated: number } {
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
      persist({ ...existing, ...patch, updated_at: now() }, `memory: bulk-update ${id}`);
      updated++;
    }
    return { transaction_id, updated };
  }

  function distinctValues(input: { field: string; include_archived?: boolean }): string[] {
    if (input.field !== "agent_id" && input.field !== "project_key") {
      throw new Error(`distinctValues field not allowed: ${input.field}`);
    }
    const includeArchived = input.include_archived === true;
    const values = new Set<string>();
    for (const memory of readAllMemories()) {
      if (!includeArchived && memory.status === MemoryStatus.Archived) continue;
      const value = (memory as Record<string, unknown>)[input.field];
      if (typeof value === "string" && value.length > 0) values.add(value);
    }
    // Parity with SQLite `ORDER BY value COLLATE NOCASE`.
    return [...values].sort((a, b) => cmpStr(a.toLowerCase(), b.toLowerCase()));
  }

  function countMemoriesByAgentId(): { agent_id: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const memory of readAllMemories()) {
      if (!memory.agent_id) continue;
      counts.set(memory.agent_id, (counts.get(memory.agent_id) ?? 0) + 1);
    }
    return [...counts.entries()].map(([agent_id, count]) => ({ agent_id, count }));
  }

  function listMemoryIdsByAgentId(agentId: string): string[] {
    return readAllMemories()
      .filter((memory) => memory.agent_id === agentId)
      .map((memory) => memory.id);
  }

  function startContext(
    input: { agent_id?: string; project_key?: string; task_summary?: string } = {},
  ) {
    const { agent_id = DEFAULT_AGENT_ID, project_key = "", task_summary = "" } = input;
    const globals = listAll({ status: MemoryStatus.Active, is_global: true });
    const privateMemories = searchMemories({
      agent_id,
      query: task_summary || project_key || agent_id,
      project_key,
      include_private: true,
      limit: 6,
    }).filter((memory) => memory.agent_id === agent_id);
    const relevant =
      task_summary || project_key
        ? searchMemories({
            agent_id,
            query: `${task_summary} ${project_key}`,
            project_key,
            include_private: true,
            limit: 8,
          })
        : [];
    const memories = uniqueById([...globals, ...privateMemories, ...relevant]);
    recordRecall(memories, agent_id, task_summary || "start_context");
    return {
      memories,
      text: formatContextPackage({
        identity: globals,
        relationship: [],
        privateMemories,
        relevant,
      }),
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
    unarchiveMemory,
    purgeMemory,
    verifyMemory,
    approveProposal,
    recordRecall,
    bulkUpdateMemory,
    distinctValues,
    countMemoriesByAgentId,
    listMemoryIdsByAgentId,
    startContext,
    appendEvent,
    listEvents,
  };
}
