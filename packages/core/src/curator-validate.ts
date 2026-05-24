// Curator operation validation + risk classification (spec §10.5 + §11 risk step).
//
// The context-dependent gate over already-schema-valid operations (curator-output
// handled the structural half). These are the HARD GUARDS §11 apply must never
// relax — they run here, in code, regardless of the model's confidence or the
// admin addendum:
//   - referential: every referenced memory/session id is in the evidence bundle;
//   - slice-boundary: no op may change visibility/project/scope or cross slices;
//   - secret: an op carrying secret-looking content is rejected (never written);
//   - empty/duplicate: no empty memory, no duplicate of an existing active one;
//   - resurrection: no create/merge/split replacement matching a tombstone (§9.1).
// Accepted ops are tagged `isProtected` + a `risk` level for the §11 decision.
// Reject reasons are fixed strings — never echo operation content (audit hygiene).

import type {
  EvidenceSlice,
  MemoryEvidenceBundle,
  SessionEvidenceBundle,
} from "./curator-evidence.js";
import {
  type TombstoneRef,
  curationContentFingerprint,
  matchesTombstone,
} from "./curator-fingerprint.js";
import type { CuratorMemoryInput, CuratorMemoryPatch, CuratorOperation } from "./curator-output.js";
import type { PrepassResult } from "./curator-prepass.js";
import { redactSecrets } from "./curator-redaction.js";
import { PROTECTED_CATEGORIES } from "./schemas/common.js";

export type RiskLevel = "safe" | "normal" | "risky" | "protected";

export interface ValidationContext {
  slice: EvidenceSlice;
  memory: MemoryEvidenceBundle;
  sessions: SessionEvidenceBundle;
  prepass: PrepassResult;
}

export type OperationOutcome =
  | { decision: "accept"; risk: RiskLevel; isProtected: boolean }
  | { decision: "reject"; reason: string };

export interface ValidatedOperation {
  operation: CuratorOperation;
  outcome: OperationOutcome;
}

export function validateOperations(
  operations: CuratorOperation[],
  context: ValidationContext,
): ValidatedOperation[] {
  const present = new Map<string, string>(); // memory id -> category, for active + proposed
  for (const m of [...context.memory.activeMemories, ...context.memory.proposedMemories]) {
    present.set(m.id, m.category);
  }
  const sessionIds = new Set(context.sessions.sessions.map((s) => s.id));
  const tombstoneRefs: TombstoneRef[] = context.memory.tombstones.map((t) => ({
    id: t.id,
    content_fingerprint: t.contentFingerprint,
    normalized_title: t.normalizedTitle,
  }));
  const exactDupIds = new Set(
    context.prepass.findings
      .filter((f) => f.kind === "exact_duplicate")
      .flatMap((f) => f.memoryIds),
  );

  const gate = { present, sessionIds, tombstoneRefs, exactDupIds, slice: context.slice, context };
  return operations.map((operation) => ({ operation, outcome: validateOne(operation, gate) }));
}

interface Gate {
  present: Map<string, string>;
  sessionIds: Set<string>;
  tombstoneRefs: TombstoneRef[];
  exactDupIds: Set<string>;
  slice: EvidenceSlice;
  context: ValidationContext;
}

function validateOne(op: CuratorOperation, gate: Gate): OperationOutcome {
  // 1. Referential — every referenced id must be in the evidence bundle.
  for (const id of referencedMemoryIds(op)) {
    if (!gate.present.has(id)) return reject("references a memory not in the evidence");
  }
  for (const id of referencedSessionIds(op)) {
    if (!gate.sessionIds.has(id)) return reject("references a session not in the evidence");
  }

  // 2. Slice-boundary — an op may not change or cross visibility/project/scope.
  if (op.type === "update" && patchTouchesBoundary(op.patch)) {
    return reject("would change a slice-boundary field (visibility/project/scope)");
  }
  const newMemories = newMemoriesOf(op);
  if (newMemories.some((m) => crossesBoundary(m, gate.slice))) {
    return reject("crosses the slice boundary (visibility/project)");
  }

  // 3. Secret — never write secret-looking content.
  if (newMemories.some(memoryHasSecret) || (op.type === "update" && patchHasSecret(op.patch))) {
    return reject("contains secret-looking material");
  }

  // 4. Empty.
  if (newMemories.some(isEmptyMemory)) return reject("would create an empty memory");

  // 5. Duplicate of an existing active memory (excluding this op's own sources).
  const sources = new Set(referencedMemoryIds(op));
  if (newMemories.some((m) => duplicatesActive(m, sources, gate.context))) {
    return reject("would duplicate an active memory");
  }

  // 6. Resurrection of deliberately-archived content (§9.1).
  if (
    newMemories.some((m) => matchesTombstone({ title: m.title, body: m.body }, gate.tombstoneRefs))
  ) {
    return reject("would resurrect archived content");
  }

  const isProtected = touchesProtected(op, gate.present);
  return { decision: "accept", isProtected, risk: classifyRisk(op, isProtected, gate.exactDupIds) };
}

function reject(reason: string): OperationOutcome {
  return { decision: "reject", reason };
}

function referencedMemoryIds(op: CuratorOperation): string[] {
  switch (op.type) {
    case "noop":
    case "archive":
    case "merge":
      return op.source_memory_ids;
    case "update":
    case "split":
      return [op.source_memory_id];
    case "create":
      return [];
  }
}

function referencedSessionIds(op: CuratorOperation): string[] {
  if (op.type === "create") return op.source_session_ids;
  if (op.type === "archive") return op.source_session_ids ?? [];
  return [];
}

function newMemoriesOf(op: CuratorOperation): CuratorMemoryInput[] {
  switch (op.type) {
    case "create":
      return [op.memory];
    case "merge":
      return [op.replacement];
    case "split":
      return op.replacements;
    default:
      return [];
  }
}

function patchTouchesBoundary(patch: CuratorMemoryPatch): boolean {
  return (
    patch.visibility !== undefined || patch.project_key !== undefined || patch.scope !== undefined
  );
}

// The slice is defined by visibility + project ownership; scope is a within-slice
// attribute (and patch scope-changes are already rejected above), so it is not a
// boundary for a freshly-created memory.
function crossesBoundary(m: CuratorMemoryInput, slice: EvidenceSlice): boolean {
  const requiredVisibility = slice.kind === "agent_private" ? "agent_private" : "common";
  if (m.visibility !== requiredVisibility) return true;
  if (slice.kind === "common_project") {
    return m.project_key != null && m.project_key !== slice.projectKey;
  }
  if (slice.kind === "common_global") {
    return m.project_key != null && m.project_key !== "";
  }
  return false; // agent_private: project_key is unrestricted within the agent's slice
}

function memoryHasSecret(m: CuratorMemoryInput): boolean {
  return textHasSecret([m.title, m.body, ...(m.tags ?? []), ...(m.applies_to ?? [])]);
}

function patchHasSecret(patch: CuratorMemoryPatch): boolean {
  return textHasSecret([
    patch.title ?? "",
    patch.body ?? "",
    ...(patch.tags ?? []),
    ...(patch.applies_to ?? []),
  ]);
}

function textHasSecret(fields: string[]): boolean {
  return fields.some((field) => redactSecrets(field).count > 0);
}

function isEmptyMemory(m: CuratorMemoryInput): boolean {
  return m.title.trim() === "" || m.body.trim() === "";
}

function duplicatesActive(
  m: CuratorMemoryInput,
  sources: Set<string>,
  context: ValidationContext,
): boolean {
  const fingerprint = curationContentFingerprint(m.title, m.body);
  return context.memory.activeMemories.some(
    (a) => !sources.has(a.id) && curationContentFingerprint(a.title, a.body) === fingerprint,
  );
}

function isProtectedCategory(category: string | undefined): boolean {
  return category !== undefined && (PROTECTED_CATEGORIES as ReadonlySet<string>).has(category);
}

function touchesProtected(op: CuratorOperation, present: Map<string, string>): boolean {
  switch (op.type) {
    case "create":
      return isProtectedCategory(op.memory.category);
    case "merge":
      return isProtectedCategory(op.replacement.category);
    case "split":
      return op.replacements.some((r) => isProtectedCategory(r.category));
    case "update":
      // Protected if the patch sets a protected category OR the existing memory is protected.
      return (
        isProtectedCategory(op.patch.category) ||
        isProtectedCategory(present.get(op.source_memory_id))
      );
    case "archive":
      return op.source_memory_ids.some((id) => isProtectedCategory(present.get(id)));
    case "noop":
      return false;
  }
}

function classifyRisk(
  op: CuratorOperation,
  isProtected: boolean,
  exactDupIds: Set<string>,
): RiskLevel {
  if (isProtected) return "protected";
  switch (op.type) {
    case "noop":
      return "safe";
    case "archive":
      return op.source_memory_ids.length > 0 &&
        op.source_memory_ids.every((id) => exactDupIds.has(id))
        ? "safe"
        : "normal";
    case "merge":
      return op.source_memory_ids.every((id) => exactDupIds.has(id)) ? "safe" : "normal";
    case "create":
      // Session-backed creates are "strong evidence" (§11 safe_only).
      return op.source_session_ids.length > 0 ? "safe" : "normal";
    case "update":
    case "split":
      return "risky";
  }
}
