// Deterministic pre-pass for the memory curator (spec §10.3).
//
// A cheap, pure analysis over the gathered memory evidence, run BEFORE the LLM
// so the model receives candidates instead of rediscovering them: exact
// duplicates, same-title-different-body merge candidates, proposed memories that
// duplicate an active one, and resurrection risks (content matching an archived
// tombstone, §9.1, flagged for suppression).
//
// Findings are hints for the prompt + apply policy — NOT operations. Fuzzy
// "obsolete considering/maybe contradicted by a later decision" detection is
// semantic and left to the LLM. Output is deterministically ordered so it
// contributes stably to the run's input hash (§10.2).

import type { MemoryEvidenceBundle, MemoryEvidenceItem } from "./curator-evidence.js";
import {
  type TombstoneRef,
  curationContentFingerprint,
  curationNormalizedTitle,
  matchesTombstone,
} from "./curator-fingerprint.js";

export type PrepassFindingKind =
  | "exact_duplicate"
  | "same_title"
  | "proposed_duplicate"
  | "resurrection_risk";

export interface PrepassFinding {
  kind: PrepassFindingKind;
  /** Memory ids involved (a duplicate group, or a proposed+active pair), sorted. */
  memoryIds: string[];
  /** For `resurrection_risk`: the archived tombstone that matched. */
  tombstoneId?: string;
  /** Human-readable hint for the prompt. */
  rationale: string;
}

export interface PrepassResult {
  findings: PrepassFinding[];
}

export function deterministicPrepass(bundle: MemoryEvidenceBundle): PrepassResult {
  const { activeMemories: active, proposedMemories: proposed, tombstones } = bundle;
  const findings: PrepassFinding[] = [];

  const activeByFingerprint = groupBy(active, fingerprintOf);

  // 1. Exact duplicates among active memories (identical normalized content).
  for (const group of activeByFingerprint.values()) {
    if (group.length > 1) {
      findings.push({
        kind: "exact_duplicate",
        memoryIds: idsOf(group),
        rationale: `${group.length} active memories have identical normalized content.`,
      });
    }
  }

  // 2. Same title, differing body — a softer merge candidate. Skip empty-
  //    normalising titles (they would group all title-less memories together).
  const titled = active.filter((m) => curationNormalizedTitle(m.title) !== "");
  for (const group of groupBy(titled, (m) => curationNormalizedTitle(m.title)).values()) {
    const distinctBodies = new Set(group.map(fingerprintOf));
    if (group.length > 1 && distinctBodies.size > 1) {
      findings.push({
        kind: "same_title",
        memoryIds: idsOf(group),
        rationale: "Active memories share a title but differ in body — possible merge.",
      });
    }
  }

  // 3. A proposed memory that duplicates an existing active memory.
  for (const candidate of proposed) {
    const matches = activeByFingerprint.get(fingerprintOf(candidate));
    if (matches && matches.length > 0) {
      findings.push({
        kind: "proposed_duplicate",
        memoryIds: idsOf([candidate, ...matches]),
        rationale: "A proposed memory duplicates an existing active memory.",
      });
    }
  }

  // 4. Resurrection risk — active or proposed content matching an archived
  //    tombstone (by redacted fingerprint or normalized title, §9.1).
  const tombstoneRefs: TombstoneRef[] = tombstones.map((t) => ({
    id: t.id,
    content_fingerprint: t.contentFingerprint,
    normalized_title: t.normalizedTitle,
  }));
  for (const memory of [...active, ...proposed]) {
    const hit = matchesTombstone({ title: memory.title, body: memory.body }, tombstoneRefs);
    if (hit) {
      findings.push({
        kind: "resurrection_risk",
        memoryIds: [memory.id],
        tombstoneId: hit.id,
        rationale: `Matches archived memory ${hit.id} — possible resurrection of deleted content.`,
      });
    }
  }

  findings.sort(compareFindings);
  return { findings };
}

// Bundle memories are already redacted; curationContentFingerprint is idempotent,
// so this yields the same key space as the tombstones built during gathering.
function fingerprintOf(memory: MemoryEvidenceItem): string {
  return curationContentFingerprint(memory.title, memory.body);
}

function idsOf(memories: MemoryEvidenceItem[]): string[] {
  return memories.map((m) => m.id).sort();
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

const KIND_ORDER: Record<PrepassFindingKind, number> = {
  exact_duplicate: 0,
  same_title: 1,
  proposed_duplicate: 2,
  resurrection_risk: 3,
};

function compareFindings(a: PrepassFinding, b: PrepassFinding): number {
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  const ids = a.memoryIds.join(",").localeCompare(b.memoryIds.join(","));
  if (ids !== 0) return ids;
  return (a.tombstoneId ?? "").localeCompare(b.tombstoneId ?? "");
}
