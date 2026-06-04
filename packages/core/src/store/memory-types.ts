// Memory store — shared type contract.
//
// The backend-agnostic memory types (`Memory`, `MemoryEvent`, `MemoryStore`
// and the `appendEvent` options) that both the SQLite store (`memory-store.ts`)
// and the markdown store implement. The store modules re-export these from
// their old paths for back-compat.
//
// Typing is intentionally loose for now (`Memory = Record<string, unknown>
// & { id: string }`). Tightening to the Zod-derived `Memory` from
// @librarian/core/schemas is a follow-up.

import type { MemoryStatus } from "../schemas/common.js";

export type Memory = Record<string, unknown> & {
  id: string;
  agent_id: string;
  // Legacy columns kept for backward compatibility with pre-4d.2
  // events and existing rows. The classifier worker is the source of
  // truth for the policy booleans now; these are not consulted on the
  // write path. Optional because new memories don't populate them.
  category?: string;
  visibility?: string;
  scope?: string;
  status: string;
  tags: string[];
  applies_to: string[];
  supersedes: string[];
  conflicts_with: string[];
  recall_count: number;
  usefulness_score: number;
  title: string;
  body: string;
  priority: string;
  confidence: string;
  project_key?: string | null;
  updated_at: string;
  curator_note?: Record<string, unknown> | null;
  // Classifier verdict booleans — set by the classifier worker, surfaced for
  // the proposal flow + dashboard. (Domain scoping was removed in D16; these
  // booleans retire with the classifier in Phase 4.)
  is_global: boolean;
  requires_approval: boolean;
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
  // Caller-backfill read seam (F0): group memory counts per stored agent id, and
  // list the memory ids owned by one agent — so backfill never touches store.db.
  countMemoriesByAgentId: () => { agent_id: string; count: number }[];
  listMemoryIdsByAgentId: (agentId: string) => string[];
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
