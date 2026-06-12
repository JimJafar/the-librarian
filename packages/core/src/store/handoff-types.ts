// Handoff store — shared type contract (sessions-rethink spec §6.2).
//
// The handoff types, the `HandoffStore` interface, and the store's error
// classes. The concrete implementation is the markdown handoff store;
// `handoff-store.ts` re-exports these from its old path for back-compat.

import type {
  ClaimHandoffInput,
  ClaimHandoffOutput,
  HandoffSummary,
  ListHandoffsInput,
  StoreHandoffInput,
  StoreHandoffOutput,
} from "../schemas/handoff.js";

/** Server-resolved metadata the MCP layer attaches before calling the store. */
export interface StoreHandoffContext {
  /** The agent that ran `/handoff` (resolved from auth context). */
  created_by_agent_id: string | null;
}

/**
 * The MCP/agent path always sees `claimed_at IS NULL` (claim removes it from
 * the picker). Admin paths (CLI, dashboard) can pass `includeClaimed: true`
 * to surface already-claimed handoffs for forensic / audit use.
 */
export interface ListHandoffsContext {
  includeClaimed?: boolean;
}

export class HandoffNotFoundError extends Error {
  constructor(public readonly handoffId: string) {
    super(`No handoff found for id ${handoffId}`);
    this.name = "HandoffNotFoundError";
  }
}

export class HandoffAlreadyClaimedError extends Error {
  constructor(
    public readonly handoffId: string,
    public readonly claimedAt: string,
    public readonly claimedBy: ClaimedBy | null,
  ) {
    super(`Handoff ${handoffId} already claimed at ${claimedAt}`);
    this.name = "HandoffAlreadyClaimedError";
  }
}

export interface ClaimedBy {
  agent_id?: string | null;
  harness?: string | null;
  source_ref?: string | null;
  cwd?: string | null;
}

/**
 * Full handoff detail for admin/dashboard + CLI surfaces (read by id). Unlike
 * `HandoffSummary` this carries the document body + claim status, so the
 * dashboard `byId` view and `the-librarian handoffs show` don't reach for raw
 * SQL against the store's database (F0 — seal the seam).
 */
export interface HandoffDetail {
  handoff_id: string;
  title: string;
  document_md: string;
  project_key: string | null;
  source_ref: string | null;
  cwd: string | null;
  created_by_agent_id: string | null;
  created_in_harness: string | null;
  tags: string[];
  created_at: string;
  claimed_at: string | null;
  claimed_by: ClaimedBy | null;
}

export interface HandoffStore {
  store: (input: StoreHandoffInput, context: StoreHandoffContext) => StoreHandoffOutput;
  list: (input: ListHandoffsInput, context: ListHandoffsContext) => HandoffSummary[];
  /**
   * Like `list`, but returns full `HandoffDetail` rows (incl. claim status and
   * the document body) for the admin dashboard list view, which renders fields
   * `HandoffSummary` omits. Same filtering semantics as `list`.
   */
  listDetails: (input: ListHandoffsInput, context: ListHandoffsContext) => HandoffDetail[];
  claim: (input: ClaimHandoffInput) => ClaimHandoffOutput;
  /** Admin / dashboard / CLI detail lookup by id; not domain-scoped. Null when absent. */
  getById: (handoffId: string) => HandoffDetail | null;
  /** Admin / test path — hard-delete a single row regardless of claim status. */
  purge: (handoffId: string) => boolean;
}
