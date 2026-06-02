// Consolidator — navigate step (spec 035 §F5: "navigate (retrieve candidates +
// ToC map) → judge → edit"). For one inbox submission this assembles the
// evidence the judge reasons over:
//   - candidates: the existing memories most relevant to the submission, via the
//     backend's index recall — the augment / update / supersede targets;
//   - toc: a bounded table-of-contents of the active corpus — the anchor for a
//     create/filing decision (so the judge files into an existing area rather
//     than spawning a near-duplicate, S1/G6).
//
// Pure orchestration over injected `recall` + `listActive` (the markdown store
// supplies these), so it's testable without an index or an LLM.

import type { Memory } from "../store/memory-store.js";

/** A compact corpus entry for the filing/create anchor (no body — the ToC is an overview). */
export interface ConsolidatorTocEntry {
  id: string;
  title: string;
  tags: string[];
  projectKey: string | null;
}

/** The evidence bundle the consolidator's judge step reasons over. */
export interface ConsolidationCandidates {
  /** Existing memories most relevant to the submission, highest-ranked first. */
  candidates: Memory[];
  /** A bounded table-of-contents of the active corpus. */
  toc: ConsolidatorTocEntry[];
}

export interface NavigateDeps {
  /**
   * Index-backed recall over active memories. A narrowed (positional) adapter
   * over the store's object-shaped `recall({ query, limit })` — the wiring
   * increment supplies `(q, n) => store.recall({ query: q, limit: n })`. recall
   * already returns active-only memories (proposals/archived are excluded).
   */
  recall: (query: string, limit: number) => Promise<Memory[]>;
  /** The active corpus, in the backend's listing order (highest-priority first). */
  listActive: () => Memory[];
}

export interface NavigateOptions {
  /** Max relevant candidates to retrieve (default 8). */
  candidateLimit?: number;
  /** Max ToC entries (default 200). */
  tocLimit?: number;
}

const DEFAULT_CANDIDATE_LIMIT = 8;
const DEFAULT_TOC_LIMIT = 200;

function toTocEntry(memory: Memory): ConsolidatorTocEntry {
  return {
    id: memory.id,
    title: String(memory.title ?? ""),
    tags: memory.tags ?? [],
    projectKey: memory.project_key ?? null,
  };
}

export async function navigateInbox(
  submissionText: string,
  deps: NavigateDeps,
  options: NavigateOptions = {},
): Promise<ConsolidationCandidates> {
  const toc = deps
    .listActive()
    .slice(0, options.tocLimit ?? DEFAULT_TOC_LIMIT)
    .map(toTocEntry);

  // An empty submission has nothing to retrieve against — return the ToC alone.
  const candidates = submissionText.trim()
    ? await deps.recall(submissionText, options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT)
    : [];

  return { candidates, toc };
}
