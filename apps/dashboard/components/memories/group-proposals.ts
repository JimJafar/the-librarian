// Group the proposal-review rows for rendering (spec 2026-06-20 T4).
//
// Split is the only multi-row shape: a curator split spins ONE source into N
// replacements, surfaced as N sibling proposed memories that all supersede the
// same source. They belong together — the operator should see the source once,
// then its replacements, and (once accepted) archive the source in one click.
//
// The grouping key is the resolved source id — targets[0].id. The endpoint
// reads the superseded source from curator_note.supersedes and exposes it via
// `targets`; top-level Memory.supersedes is hardcoded [] in createMemory, so it
// is never the real source in production. run_id is NOT the key either: it is
// grooming-only (absent on intake splits), so it can only ever be an optional
// tiebreaker, never the join. We group by the source the replacements point at,
// which both intake and grooming splits record on the target.
//
// A lone split replacement (only one sibling) is NOT grouped: it renders as a
// normal split card, because the "archive the shared source" affordance only
// makes sense once a split's replacements actually fan out.

import type { ProposalReviewRow } from "@/components/memories/types";

export type ProposalGroup =
  | { kind: "single"; row: ProposalReviewRow }
  | {
      kind: "split";
      /** The shared source the replacements supersede (resolved target). */
      source: ProposalReviewRow["targets"][number];
      /** The sibling split replacements (≥2), in input order. */
      replacements: ProposalReviewRow[];
    };

function splitSourceId(row: ProposalReviewRow): string | null {
  if (row.action !== "split") return null;
  // The shared source: the first resolved target, which the endpoint resolves
  // from curator_note.supersedes. Top-level proposal.supersedes is hardcoded []
  // in production (createMemory), so reading it here would always be undefined.
  return row.targets[0]?.id ?? null;
}

export function groupProposalRows(rows: ProposalReviewRow[]): ProposalGroup[] {
  // Bucket split replacements by their shared source id, preserving first-seen
  // order so a group lands where its first replacement appeared.
  const splitBuckets = new Map<string, ProposalReviewRow[]>();
  for (const row of rows) {
    const sourceId = splitSourceId(row);
    if (sourceId === null) continue;
    const bucket = splitBuckets.get(sourceId);
    if (bucket) bucket.push(row);
    else splitBuckets.set(sourceId, [row]);
  }

  const groups: ProposalGroup[] = [];
  const emittedSource = new Set<string>();

  for (const row of rows) {
    const sourceId = splitSourceId(row);
    const bucket = sourceId !== null ? splitBuckets.get(sourceId) : undefined;

    // A real split group: ≥2 siblings sharing a source, with that source
    // resolved. Emit the group once, at the first sibling's position.
    if (sourceId !== null && bucket && bucket.length >= 2) {
      if (emittedSource.has(sourceId)) continue;
      emittedSource.add(sourceId);
      const source =
        bucket.map((r) => r.targets.find((t) => t.id === sourceId)).find((t) => t != null) ??
        bucket[0]!.targets[0];
      if (source) {
        groups.push({ kind: "split", source, replacements: bucket });
        continue;
      }
      // Source didn't resolve — fall through and render each as a single card.
    }

    groups.push({ kind: "single", row });
  }

  return groups;
}
