// Baseline caller-id audit — the migration dry-run for the naming contract.
//
// `auditCallerIds` runs `normaliseCallerId` over the existing stored ids
// (memories.agent_id, sessions.created_by_agent_id / current_agent_id) WITHOUT
// changing anything, so an operator can see — before any backfill — which raw
// variants would collapse into one canonical id (§9 Phase 0) and which ids have
// no canonical form. It deliberately applies no aliases: alias decisions come
// after a human reviews the collapse/collision groups (§10).

import { normaliseCallerId } from "./caller-identity.js";

export interface CallerIdGroup {
  /** The canonical id all variants normalise to. */
  canonical: string;
  /** Distinct raw inputs that map to `canonical`, sorted. */
  variants: string[];
}

export interface CallerIdAudit {
  /** Every canonical group, collapse groups (>1 variant) first, then by name. */
  groups: CallerIdGroup[];
  /** The subset of `groups` with more than one raw variant — these merge. */
  collapses: CallerIdGroup[];
  /** Raw ids that throw on normalisation (no canonical form). */
  invalid: string[];
  /** Count of distinct, non-empty raw ids considered. */
  total: number;
}

/**
 * Dry-run audit of caller ids. Pure: no store access, no mutation. Empty /
 * whitespace-only ids are skipped entirely; exact duplicates are de-duplicated.
 */
export function auditCallerIds(rawIds: Iterable<string>): CallerIdAudit {
  const seen = new Set<string>();
  const byCanonical = new Map<string, Set<string>>();
  const invalid: string[] = [];

  for (const raw of rawIds) {
    if (typeof raw !== "string" || raw.trim() === "" || seen.has(raw)) continue;
    seen.add(raw);
    let canonical: string;
    try {
      canonical = normaliseCallerId(raw);
    } catch {
      invalid.push(raw);
      continue;
    }
    const variants = byCanonical.get(canonical) ?? new Set<string>();
    variants.add(raw);
    byCanonical.set(canonical, variants);
  }

  const groups: CallerIdGroup[] = [...byCanonical.entries()]
    .map(([canonical, variants]) => ({ canonical, variants: [...variants].sort() }))
    .sort((a, b) => {
      const aIsCollapse = a.variants.length > 1 ? 0 : 1;
      const bIsCollapse = b.variants.length > 1 ? 0 : 1;
      return aIsCollapse - bIsCollapse || a.canonical.localeCompare(b.canonical);
    });

  return {
    groups,
    collapses: groups.filter((group) => group.variants.length > 1),
    invalid,
    total: seen.size,
  };
}
