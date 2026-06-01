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

  return { createMemory, getMemory };
}
