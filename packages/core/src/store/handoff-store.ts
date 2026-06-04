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
import { HandoffAlreadyClaimedError, HandoffNotFoundError } from "./handoff-types.js";
import type {
  ClaimedBy,
  HandoffDetail,
  HandoffStore,
  ListHandoffsContext,
  StoreHandoffContext,
} from "./handoff-types.js";

// Re-exported from the old path so existing importers don't change (PR-1).
export { HandoffAlreadyClaimedError, HandoffNotFoundError } from "./handoff-types.js";
export type {
  ClaimedBy,
  HandoffDetail,
  HandoffStore,
  ListHandoffsContext,
  StoreHandoffContext,
} from "./handoff-types.js";

interface HandoffRow {
  id: string;
  title: string;
  document_md: string;
  project_key: string | null;
  source_ref: string | null;
  cwd: string | null;
  created_by_agent_id: string | null;
  created_in_harness: string | null;
  tags_json: string;
  created_at: string;
  claimed_at: string | null;
  claimed_by_json: string | null;
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
        id, title, document_md, project_key, source_ref, cwd,
        created_by_agent_id, created_in_harness, tags_json,
        created_at, claimed_at, claimed_by_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      input.title,
      input.document_md,
      input.project_key ?? null,
      input.source_ref ?? null,
      input.cwd ?? null,
      context.created_by_agent_id,
      input.harness ?? null,
      JSON.stringify(input.tags ?? []),
      createdAt,
    );
    return { handoff_id: id, created_at: createdAt };
  }

  function queryHandoffRows(input: ListHandoffsInput, context: ListHandoffsContext): HandoffRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!context.includeClaimed) where.push("claimed_at IS NULL");

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
    return db
      .prepare(
        `SELECT * FROM handoffs
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as HandoffRow[];
  }

  function listHandoffs(input: ListHandoffsInput, context: ListHandoffsContext): HandoffSummary[] {
    return queryHandoffRows(input, context).map(rowToSummary);
  }

  function listDetailsHandoffs(
    input: ListHandoffsInput,
    context: ListHandoffsContext,
  ): HandoffDetail[] {
    return queryHandoffRows(input, context).map(rowToDetail);
  }

  function claimHandoff(input: ClaimHandoffInput): ClaimHandoffOutput {
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
      const updated = db
        .prepare(
          `UPDATE handoffs SET claimed_at = ?, claimed_by_json = ?
           WHERE id = ? AND claimed_at IS NULL RETURNING *`,
        )
        .all(claimedAt, claimedByJson, input.handoff_id) as unknown as HandoffRow[];

      if (updated.length === 1) {
        const row = updated[0]!;
        db.exec("COMMIT");
        return rowToClaimResult(row);
      }

      // The UPDATE didn't fire. Two possibilities:
      //   1. The row doesn't exist → 404.
      //   2. The row exists but is already claimed → 409 with the existing claim.
      const existing = db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(input.handoff_id) as
        | HandoffRow
        | undefined;
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

  function getByIdHandoff(handoffId: string): HandoffDetail | null {
    const row = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(handoffId) as
      | HandoffRow
      | undefined;
    return row ? rowToDetail(row) : null;
  }

  return {
    store: storeHandoff,
    list: listHandoffs,
    listDetails: listDetailsHandoffs,
    claim: claimHandoff,
    getById: getByIdHandoff,
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

// Full detail projection for admin/dashboard/CLI reads. `claimed_by` is
// normalized to the canonical {agent_id, harness, source_ref, cwd} shape via
// parseClaimedBy — not a raw JSON passthrough — which is safe because claim()
// is the sole writer of claimed_by_json and writes exactly those keys.
function rowToDetail(row: HandoffRow): HandoffDetail {
  return {
    handoff_id: row.id,
    title: row.title,
    document_md: row.document_md,
    project_key: row.project_key,
    source_ref: row.source_ref,
    cwd: row.cwd,
    created_by_agent_id: row.created_by_agent_id,
    created_in_harness: row.created_in_harness,
    tags: parseTags(row.tags_json),
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    claimed_by: parseClaimedBy(row.claimed_by_json),
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
