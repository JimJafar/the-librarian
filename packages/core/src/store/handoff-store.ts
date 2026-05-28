// Handoff store (sessions-rethink spec §6.2).
//
// The `handoffs` table is SQLite-authoritative — there is no JSONL ledger
// backing it. Each handoff is a self-contained narrative the outgoing agent
// stored at `/handoff`; `/takeover` claims it atomically with `claim_handoff`.
//
// The atomic claim uses `BEGIN IMMEDIATE` so the write lock is taken up
// front. Under multi-writer WAL the alternative — a SELECT followed by an
// UPDATE — races between readers; `BEGIN IMMEDIATE` serializes claimants and
// guarantees the follow-up SELECT in the 409 path reflects a consistent
// snapshot.

import type { DatabaseSync } from "node:sqlite";
import { makeId, nowIso } from "../constants.js";
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
  /** Multi-tenant isolation. Resolved by domain-resolution at the MCP layer. */
  domain: string;
  /** The agent that ran `/handoff` (resolved from auth context). */
  created_by_agent_id: string | null;
}

/**
 * Listing is server-scoped by domain. A non-null `domain` is a hard filter
 * (multi-tenant isolation, identical to memory tools); a null `domain`
 * bypasses the filter and is reserved for admin role (mirrors `recall`'s
 * `admin: true` path — never reachable from an agent-role caller).
 *
 * The MCP/agent path always sees `claimed_at IS NULL` (claim removes it from
 * the picker). Admin paths (CLI, dashboard) can pass `includeClaimed: true`
 * to surface already-claimed handoffs for forensic / audit use.
 */
export interface ListHandoffsContext {
  domain: string | null;
  includeClaimed?: boolean;
}

/** Claim is server-scoped by domain. Null `domain` is admin-only (see ListHandoffsContext). */
export interface ClaimHandoffContext {
  domain: string | null;
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

interface HandoffRow {
  id: string;
  title: string;
  document_md: string;
  project_key: string | null;
  source_ref: string | null;
  cwd: string | null;
  domain: string;
  created_by_agent_id: string | null;
  created_in_harness: string | null;
  tags_json: string;
  created_at: string;
  claimed_at: string | null;
  claimed_by_json: string | null;
}

export interface HandoffStore {
  store: (input: StoreHandoffInput, context: StoreHandoffContext) => StoreHandoffOutput;
  list: (input: ListHandoffsInput, context: ListHandoffsContext) => HandoffSummary[];
  claim: (input: ClaimHandoffInput, context: ClaimHandoffContext) => ClaimHandoffOutput;
  /** Admin / test path — hard-delete a single row regardless of claim status. */
  purge: (handoffId: string) => boolean;
}

export function createHandoffStore(deps: { db: DatabaseSync }): HandoffStore {
  const { db } = deps;

  function storeHandoff(
    input: StoreHandoffInput,
    context: StoreHandoffContext,
  ): StoreHandoffOutput {
    const id = makeId("hdo");
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO handoffs (
        id, title, document_md, project_key, source_ref, cwd, domain,
        created_by_agent_id, created_in_harness, tags_json,
        created_at, claimed_at, claimed_by_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      input.title,
      input.document_md,
      input.project_key ?? null,
      input.source_ref ?? null,
      input.cwd ?? null,
      context.domain,
      context.created_by_agent_id,
      input.harness ?? null,
      JSON.stringify(input.tags ?? []),
      createdAt,
    );
    return { handoff_id: id, created_at: createdAt };
  }

  function listHandoffs(input: ListHandoffsInput, context: ListHandoffsContext): HandoffSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!context.includeClaimed) where.push("claimed_at IS NULL");
    if (context.domain !== null) {
      where.push("domain = ?");
      params.push(context.domain);
    }

    // Per §6.1 D9: the picker filters by `project_key = ?` AND `cwd = ?` when
    // both are supplied; if either is null/undefined the axis is unfiltered.
    if (input.project_key != null) {
      where.push("project_key = ?");
      params.push(input.project_key);
    }
    if (input.cwd != null) {
      where.push("cwd = ?");
      params.push(input.cwd);
    }
    if (input.harness != null) {
      where.push("created_in_harness = ?");
      params.push(input.harness);
    }
    const limit = input.limit ?? 20;
    params.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT * FROM handoffs
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as HandoffRow[];

    return rows.map(rowToSummary);
  }

  function claimHandoff(
    input: ClaimHandoffInput,
    context: ClaimHandoffContext,
  ): ClaimHandoffOutput {
    const claimedAt = nowIso();
    const claimedByJson = JSON.stringify({
      agent_id: input.claiming_agent_id ?? null,
      harness: input.claiming_harness ?? null,
      source_ref: input.claiming_source_ref ?? null,
      cwd: input.claiming_cwd ?? null,
    });

    // Take the write lock up front so the UPDATE+SELECT pair is a single
    // critical section. SQLite's deferred-transaction default would allow a
    // racing claimant to slip between our UPDATE and SELECT under WAL.
    db.exec("BEGIN IMMEDIATE");
    try {
      // A non-null domain hard-filters the UPDATE (multi-tenant isolation,
      // identical to memory tools). Admin role passes null, which broadens
      // the predicate to "any row with this id, any domain".
      const updateSql =
        context.domain === null
          ? `UPDATE handoffs SET claimed_at = ?, claimed_by_json = ?
             WHERE id = ? AND claimed_at IS NULL RETURNING *`
          : `UPDATE handoffs SET claimed_at = ?, claimed_by_json = ?
             WHERE id = ? AND domain = ? AND claimed_at IS NULL RETURNING *`;
      const updateBinds: (string | null)[] =
        context.domain === null
          ? [claimedAt, claimedByJson, input.handoff_id]
          : [claimedAt, claimedByJson, input.handoff_id, context.domain];
      const updated = db.prepare(updateSql).all(...updateBinds) as unknown as HandoffRow[];

      if (updated.length === 1) {
        const row = updated[0]!;
        db.exec("COMMIT");
        return rowToClaimResult(row);
      }

      // The UPDATE didn't fire. Two possibilities (same domain scoping):
      //   1. The row doesn't exist (or isn't in our domain) → 404.
      //   2. The row exists but is already claimed → 409 with the existing claim.
      const selectSql =
        context.domain === null
          ? `SELECT * FROM handoffs WHERE id = ?`
          : `SELECT * FROM handoffs WHERE id = ? AND domain = ?`;
      const selectBinds: string[] =
        context.domain === null ? [input.handoff_id] : [input.handoff_id, context.domain];
      const existing = db.prepare(selectSql).get(...selectBinds) as HandoffRow | undefined;
      db.exec("COMMIT");
      if (!existing) throw new HandoffNotFoundError(input.handoff_id);
      throw new HandoffAlreadyClaimedError(
        input.handoff_id,
        existing.claimed_at ?? "",
        parseClaimedBy(existing.claimed_by_json),
      );
    } catch (error) {
      // The 404/409 throws happen AFTER `COMMIT`, so the defensive ROLLBACK
      // below is a no-op on those paths (SQLite reports "no transaction
      // active" which we swallow). The catch also handles a thrown UPDATE
      // or SELECT, where COMMIT hasn't run yet and ROLLBACK is the right
      // cleanup. Either way the caller sees the original error.
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no active transaction — happy-path COMMIT already ran */
      }
      throw error;
    }
  }

  function purgeHandoff(handoffId: string): boolean {
    const stmt = db.prepare("DELETE FROM handoffs WHERE id = ?");
    const result = stmt.run(handoffId);
    return Number(result.changes) > 0;
  }

  return {
    store: storeHandoff,
    list: listHandoffs,
    claim: claimHandoff,
    purge: purgeHandoff,
  };
}

function rowToSummary(row: HandoffRow): HandoffSummary {
  return {
    handoff_id: row.id,
    title: row.title,
    project_key: row.project_key,
    source_ref: row.source_ref,
    cwd: row.cwd,
    created_in_harness: row.created_in_harness,
    created_by_agent_id: row.created_by_agent_id,
    created_at: row.created_at,
    tags: parseTags(row.tags_json),
  };
}

function rowToClaimResult(row: HandoffRow): ClaimHandoffOutput {
  if (!row.claimed_at) {
    // Unreachable — the UPDATE above sets it. Guard so the type narrows.
    throw new Error("claim row missing claimed_at after UPDATE");
  }
  return {
    handoff_id: row.id,
    title: row.title,
    document_md: row.document_md,
    created_by_agent_id: row.created_by_agent_id,
    created_in_harness: row.created_in_harness,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
  };
}

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseClaimedBy(json: string | null): ClaimedBy | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      agent_id: typeof parsed.agent_id === "string" ? parsed.agent_id : null,
      harness: typeof parsed.harness === "string" ? parsed.harness : null,
      source_ref: typeof parsed.source_ref === "string" ? parsed.source_ref : null,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
    };
  } catch {
    return null;
  }
}
