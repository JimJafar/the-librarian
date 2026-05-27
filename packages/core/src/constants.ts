// Normalization helpers + the few constants that aren't covered by the
// Zod-derived enums in schemas/common.ts.
//
// The enums (Category, Visibility, Scope, MemoryStatus, Priority,
// Confidence, SessionStatus, SessionCaptureMode, SessionPayloadType,
// MemoryEventType, SessionEventType, VerifyResult) are the single source
// of truth for wire-format strings — `normalizeMemoryInput` and the
// `normalizeEnum` helper below funnel free-form input through them.

import {
  Category,
  Confidence,
  PROTECTED_CATEGORIES,
  Priority,
  MemoryStatus,
  Scope,
  Visibility,
} from "./schemas/common.js";

export const DEFAULT_AGENT_ID = "unknown-agent";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === "") return [];
  return [String(value)];
}

export function normalizeString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value).trim();
}

export function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = normalizeString(value, fallback);
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

export interface NormalizedMemoryInput {
  title: string;
  body: string;
  category: Category;
  visibility: Visibility;
  agent_id: string;
  scope: Scope;
  project_key: string;
  applies_to: string[];
  priority: Priority;
  confidence: Confidence;
  tags: string[];
  status: MemoryStatus;
  // memory-domain-isolation PR 1 / T1.2 + T1.3. `domain` defaults to
  // 'general' until PR 3 wires conv_state-driven assignment. The two
  // booleans are derived from `category` here as a legacy bridge — PR 6
  // (classifier shadow mode) starts logging an alternate verdict, and
  // PR 7 (cutover) replaces this derivation with the classifier output.
  domain: string;
  is_global: boolean;
  requires_approval: boolean;
}

// Derive the two write-path policy booleans from the legacy category enum.
// Lives next to `PROTECTED_CATEGORIES` so the relationship is obvious:
// `requires_approval` is a superset of the existing protected-routing
// behaviour, expressed as a column rather than a hard-coded set.
//
// Rules (spec §7.2 — legacy bridge):
//   identity, relationship                            → requires_approval=1
//   identity, relationship, preferences               → is_global=1
//   everything else                                   → both 0
export function deriveLegacyMemoryFlags(category: Category): {
  is_global: boolean;
  requires_approval: boolean;
} {
  const isProtected = category === Category.Identity || category === Category.Relationship;
  const isGlobal = isProtected || category === Category.Preferences;
  return { is_global: isGlobal, requires_approval: isProtected };
}

export function normalizeMemoryInput(input: Record<string, unknown> = {}): NormalizedMemoryInput {
  const category = normalizeEnum(input.category, Object.values(Category), Category.Lessons);
  const visibility = normalizeEnum(input.visibility, Object.values(Visibility), Visibility.Common);
  const scope = normalizeEnum(
    input.scope,
    Object.values(Scope),
    category === Category.Projects ? Scope.Project : Scope.Global,
  );
  const flags = deriveLegacyMemoryFlags(category);

  return {
    title: normalizeString(input.title || input.content || "Untitled memory"),
    body: normalizeString(input.body || input.content || ""),
    category,
    visibility,
    agent_id: normalizeString(input.agent_id, DEFAULT_AGENT_ID),
    scope,
    project_key: normalizeString(input.project_key),
    applies_to: asArray(input.applies_to),
    priority: normalizeEnum(input.priority, Object.values(Priority), Priority.Normal),
    confidence: normalizeEnum(input.confidence, Object.values(Confidence), Confidence.Working),
    tags: asArray(input.tags),
    status: normalizeEnum(input.status, Object.values(MemoryStatus), MemoryStatus.Active),
    // PR 1: domain is always 'general' on write. PR 3 (T3.1) reads
    // conv_state and sets it server-side from the conversation's domain;
    // out-of-session writes will route to the proposal queue with
    // domain=NULL per §4.14.
    domain: "general",
    is_global: flags.is_global,
    requires_approval: flags.requires_approval,
  };
}

export function isProtectedCategory(category: string): boolean {
  return PROTECTED_CATEGORIES.has(category as Category);
}
