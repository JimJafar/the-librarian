// Memory store — shared type contract.
//
// The memory types (`Memory`, `MemoryStore`) the markdown store implements.
// The store modules re-export these from their old paths for back-compat.
//
// Typing is intentionally loose for now (`Memory = Record<string, unknown>
// & { id: string }`). Tightening to the Zod-derived `Memory` from
// @librarian/core/schemas is a follow-up.

import type { MemoryStatus } from "../schemas/common.js";

/**
 * An agent's open flag against a memory (spec 047 / ADR 0006). A flag is a
 * negative-only signal — "this memory is incorrect / misleading / outdated" —
 * stored as a list on the memory doc (same storage method `proposed` uses, no
 * separate ledger). A flag never changes the memory's status; it routes the
 * memory to review and soft-demotes it in recall. Multiple agents may flag.
 */
export interface MemoryFlag {
  agent_id: string;
  reason: string;
  created_at: string;
}

export type Memory = Record<string, unknown> & {
  id: string;
  agent_id: string;
  status: string;
  tags: string[];
  applies_to: string[];
  supersedes: string[];
  conflicts_with: string[];
  // Open agent flags routing this memory to review (spec 047 / ADR 0006).
  // Default []. A non-empty list soft-demotes the memory in recall but never
  // changes its status.
  flags: MemoryFlag[];
  title: string;
  body: string;
  confidence: string;
  updated_at: string;
  curator_note?: Record<string, unknown> | null;
  // Routing booleans — set only by admin/curator via the trusted options
  // channel (the classifier was deleted, rethink T4), surfaced for the
  // proposal flow + dashboard. (Domain scoping was removed in D16.)
  is_global: boolean;
  requires_approval: boolean;
};

export interface MemoryStore {
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
    statuses: { value: unknown; count: number }[];
    total: number;
  };
  getRelated: (id: string) => null | {
    memory: Memory;
    related: { memory: Memory; ratio: number; isDuplicate: boolean }[];
  };
  getMemory: (id: string) => Memory | null;
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
  bulkUpdateMemory: (input: { ids: string[]; patch: { agent_id?: string }; agent_id?: string }) => {
    transaction_id: string;
    updated: number;
  };
  distinctValues: (input: { field: string; include_archived?: boolean }) => string[];
  // Caller-backfill read seam (F0): group memory counts per stored agent id, and
  // list the memory ids owned by one agent — so backfill never touches store.db.
  countMemoriesByAgentId: () => { agent_id: string; count: number }[];
  listMemoryIdsByAgentId: (agentId: string) => string[];
  archiveMemory: (id: string, agent_id?: string) => Memory | null;
  // The narrow inverse of archiveMemory (spec 044 D-5b): restore an archived
  // memory to Active (idempotent on an already-active row). Drives admin unmerge.
  unarchiveMemory: (id: string, agent_id?: string) => Memory | null;
  // Permanently delete an ARCHIVED memory: hard-deletes the vault document (the
  // narrow archive=move exception) + commits; the disposable index drops the row
  // on rebuild. Archived-only — throws for an active/proposed memory (archive it
  // first). Idempotent: an already-absent id is a no-op returning null.
  purgeMemory: (id: string, agent_id?: string) => Memory | null;
  // Flag a memory as incorrect/misleading/outdated (spec 047 / ADR 0006).
  // Appends an open flag to the doc's `flags` list; never changes status
  // (route-to-review, never archive). `agent_id` is the calling agent,
  // resolved server-side. Fail-soft: unknown id → null.
  flagMemory: (id: string, reason: string, agent_id?: string) => Memory | null;
  // Clear every open flag on a memory — the dashboard's adjudication
  // primitive. Status is left untouched. Fail-soft: unknown id → null.
  resolveFlags: (id: string, agent_id?: string) => Memory | null;
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
