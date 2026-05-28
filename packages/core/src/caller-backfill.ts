// Phase-3 backfill — rewrite stored caller ids to canonical form (§9 Phase 3).
//
// The audit (`auditCallerIds`) is the read-only dry-run that shows which ids
// would collapse; this is the write step that actually moves them. It applies
// a one-time backfill alias map (e.g. `claude → claude-code`,
// `system → system-migration`) AFTER normalisation. That map is deliberately
// SEPARATE from the live resolver alias map (§4.4): the backfill rewrites
// stored history once, whereas the resolver's live aliases — intentionally
// empty for these ids — would remap every future call. Keeping them apart is
// how we honour "backfill the rows, but keep `claude` distinct going forward".
//
// Reattribution is JSONL-canonical: events.jsonl is the source of truth and
// SQLite is a rebuilt projection, so rewriting `agent_id` appends a
// `memory.bulk_updated` event via `bulkUpdateMemory` rather than a direct
// SQL UPDATE (which would be clobbered on the next projection rebuild).
//
// Invariants (§9): never guess `unknown-agent`, leave unnormalisable ids
// untouched, no-op in dry-run, and idempotent on re-run.
//
// sessions-rethink PR 7 — the sessions section is retired with the rest of
// the session subsystem. The report and types now only cover memories.

import { type CallerAliasMap, SYSTEM_ACTOR_IDS, toCanonicalId } from "./caller-identity.js";
import { DEFAULT_AGENT_ID } from "./constants.js";
import type { LibrarianStore } from "./store/librarian-store.js";

export interface BackfillChange {
  /** The stored id being replaced. */
  from: string;
  /** Its canonical replacement. */
  to: string;
  /** Memories currently carrying `from` as `agent_id`. */
  count: number;
}

export interface BackfillSection {
  /** Reattributions applied (or, in dry-run, that would be applied). */
  changes: BackfillChange[];
  /** Count of distinct, non-empty ids scanned. */
  scanned: number;
  /** Ids deliberately left untouched: already canonical, `unknown-agent`, or unnormalisable. */
  skipped: string[];
}

export interface CallerBackfillReport {
  memories: BackfillSection;
  /** Whether the run mutated storage (`true`) or was a dry-run (`false`). */
  apply: boolean;
}

export interface BackfillOptions {
  /**
   * One-time backfill alias map applied AFTER normalisation. Distinct from the
   * live resolver alias map — these mappings rewrite stored history but are not
   * consulted on live calls (§9 Phase 3 vs §4.4).
   */
  aliases?: CallerAliasMap;
  /** Actor recorded against the memory reattribution events. Defaults to `system-migration` (§6). */
  actorId?: string;
  /** When false (default), compute the report without mutating anything. */
  apply?: boolean;
}

/**
 * Plan a reattribution for one stored id. Returns the canonical target, or
 * `null` when the id should be left as-is: empty, the legacy `unknown-agent`
 * sentinel (§9 forbids guessing it), already canonical, or unnormalisable.
 */
function plannedTarget(raw: string, aliases: CallerAliasMap): string | null {
  if (!raw || raw === DEFAULT_AGENT_ID) return null;
  let canonical: string;
  try {
    canonical = toCanonicalId(raw, aliases);
  } catch {
    return null; // no canonical form — leave it rather than dropping/guessing
  }
  return canonical === raw ? null : canonical;
}

function backfillMemories(
  store: LibrarianStore,
  aliases: CallerAliasMap,
  actorId: string,
  apply: boolean,
): BackfillSection {
  const rows = store.db
    .prepare(
      "SELECT agent_id AS id, COUNT(*) AS n FROM memories " +
        "WHERE agent_id IS NOT NULL AND agent_id != '' GROUP BY agent_id",
    )
    .all() as Array<{ id: string; n: number }>;

  const changes: BackfillChange[] = [];
  const skipped: string[] = [];
  for (const { id, n } of rows) {
    const target = plannedTarget(id, aliases);
    if (target === null) {
      skipped.push(id);
      continue;
    }
    changes.push({ from: id, to: target, count: n });
    if (apply) {
      const ids = (
        store.db.prepare("SELECT id FROM memories WHERE agent_id = ?").all(id) as Array<{
          id: string;
        }>
      ).map((row) => row.id);
      // Append-event path: durable through the JSONL → SQLite projection rebuild.
      store.bulkUpdateMemory({ ids, patch: { agent_id: target }, agent_id: actorId });
    }
  }
  return { changes, scanned: rows.length, skipped };
}

/**
 * Backfill stored caller ids to canonical form across memories.
 * Pass `apply: true` to mutate; otherwise returns the planned changes only.
 */
export function backfillCallerIds(
  store: LibrarianStore,
  options: BackfillOptions = {},
): CallerBackfillReport {
  const aliases = options.aliases ?? {};
  const apply = options.apply === true;
  const actorId = options.actorId ?? SYSTEM_ACTOR_IDS.migration;

  return {
    memories: backfillMemories(store, aliases, actorId, apply),
    apply,
  };
}
