// Proposal drift — spec 072 (D1/D8, SC 5).
//
// A proposal is a judgment about specific memories, frozen at draft time and
// then left in a queue for a human. While it waits, those memories can change:
// an agent files something, or the operator edits by hand. Approving afterwards
// archives the edited source and activates text written against the version
// that no longer exists — silently dropping the newer edit from the active
// corpus (it survives only in git).
//
// T3 stamps a content digest per superseded source at draft time. This module
// is the other half: recompute those digests against the corpus now and say
// whether anything moved.
//
// The three states, and why the ordering between them matters:
//   drifted — a source's content changed. Refuses approve (D3, no override).
//   unknown — cannot be determined: the proposal predates digests (D2), or the
//             source no longer resolves. NEVER blocks. Treating unknown as
//             drifted would make every proposal already in the queue
//             unapprovable on upgrade, which is why D2 chose to let those drain.
//   clean   — every source still digests to what was recorded.
// `drifted` outranks `unknown`, so a proposal with one changed source and one
// uncheckable source is still refused.
//
// Read defensively throughout: `curator_note` is a free-form record on the
// markdown document, so every field here may be absent or the wrong shape.

import { type DiffableMemory, memoryContentDigest } from "../formatters/memory-diff.js";

export type ProposalDriftStatus = "clean" | "drifted" | "unknown";

export interface ProposalSourceDrift {
  id: string;
  /** The source's CURRENT title, or null when it no longer resolves. */
  title: string | null;
  /** True only when a recorded digest exists and no longer matches. */
  drifted: boolean;
}

export interface ProposalDrift {
  status: ProposalDriftStatus;
  sources: ProposalSourceDrift[];
}

/** The memory shape drift needs: enough to digest, plus an id to report. */
type DriftReadable = DiffableMemory & { id?: string };

/**
 * Compare a proposal's recorded source digests against the corpus now.
 *
 * `getMemory` resolves ids through whatever scope the caller is entitled to —
 * an id the caller cannot see reads as `unknown`, never as `clean`.
 */
export function proposalDrift(
  curatorNote: Record<string, unknown> | null | undefined,
  getMemory: (id: string) => DriftReadable | null,
): ProposalDrift {
  const supersedes = curatorNote?.supersedes;
  if (!Array.isArray(supersedes)) return { status: "clean", sources: [] };
  const sourceIds = supersedes.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (sourceIds.length === 0) return { status: "clean", sources: [] };

  const rawDigests = curatorNote?.source_digests;
  const digests =
    typeof rawDigests === "object" && rawDigests !== null
      ? (rawDigests as Record<string, unknown>)
      : {};

  const sources: ProposalSourceDrift[] = [];
  let anyDrifted = false;
  let anyUnknown = false;

  for (const id of sourceIds) {
    const recorded = digests[id];
    const current = getMemory(id);
    if (typeof recorded !== "string" || current === null) {
      // No baseline, or nothing left to compare it against.
      anyUnknown = true;
      sources.push({ id, title: current?.title ?? null, drifted: false });
      continue;
    }
    const drifted = memoryContentDigest(current) !== recorded;
    if (drifted) anyDrifted = true;
    sources.push({ id, title: current.title, drifted });
  }

  const status: ProposalDriftStatus = anyDrifted ? "drifted" : anyUnknown ? "unknown" : "clean";
  return { status, sources };
}

/** The changed sources, for a refusal message that names what moved. */
export function driftedSources(drift: ProposalDrift): ProposalSourceDrift[] {
  return drift.sources.filter((source) => source.drifted);
}
