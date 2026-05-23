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
  // Nullable JSON provenance set by the memory curator's apply layer
  // (memory-curator spec §8); ordinary callers leave it null.
  curator_note: Record<string, unknown> | null;
}

export function normalizeMemoryInput(input: Record<string, unknown> = {}): NormalizedMemoryInput {
  const category = normalizeEnum(input.category, Object.values(Category), Category.Lessons);
  const visibility = normalizeEnum(input.visibility, Object.values(Visibility), Visibility.Common);
  const scope = normalizeEnum(
    input.scope,
    Object.values(Scope),
    category === Category.Projects ? Scope.Project : Scope.Global,
  );

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
    // Structured passthrough — the curator sets a JSON object; everyone else null.
    curator_note:
      input.curator_note && typeof input.curator_note === "object"
        ? (input.curator_note as Record<string, unknown>)
        : null,
  };
}

export function isProtectedCategory(category: string): boolean {
  return PROTECTED_CATEGORIES.has(category as Category);
}
