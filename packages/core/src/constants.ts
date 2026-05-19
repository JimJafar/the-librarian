// Shared constants + normalization helpers for The Librarian core.
//
// Ported from constants.js as part of T3.3 (when the memory-store TS
// module needed the symbols at compile time and tsc only emits .ts files
// into dist). T3.5 will retire the remaining ad-hoc literal arrays in
// favour of the Zod-derived constants in schemas/common.ts.

export const CATEGORIES: readonly string[] = [
  "identity",
  "relationship",
  "preferences",
  "projects",
  "environment",
  "tools",
  "lessons",
  "people",
  "open_threads",
];

export const PROTECTED_CATEGORIES: ReadonlySet<string> = new Set(["identity", "relationship"]);

export const VISIBILITIES: readonly string[] = ["common", "agent_private"];
export const SCOPES: readonly string[] = ["global", "project", "environment", "tool", "session"];
export const STATUSES: readonly string[] = [
  "active",
  "proposed",
  "conflicted",
  "archived",
  "deleted",
  "rejected",
];
export const PRIORITIES: readonly string[] = ["low", "normal", "high", "core"];
export const CONFIDENCES: readonly string[] = ["tentative", "working", "strong"];

export const SESSION_STATUSES: readonly string[] = [
  "active",
  "paused",
  "ended",
  "archived",
  "deleted",
];
export const SESSION_CAPTURE_MODES: readonly string[] = ["off", "summary", "log"];
export const SESSION_EVENT_TYPES: readonly string[] = [
  "session.started",
  "session.attached_to_harness",
  "session.event_recorded",
  "session.checkpointed",
  "session.paused",
  "session.ended",
  "session.archived",
  "session.restored",
  "session.deleted",
  "session.promoted_to_memory",
];
export const SESSION_PAYLOAD_TYPES: readonly string[] = [
  "message",
  "command",
  "file",
  "error",
  "decision",
  "question",
  "checkpoint",
  "handover",
  "note",
];

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
  category: string;
  visibility: string;
  agent_id: string;
  scope: string;
  project_key: string;
  applies_to: string[];
  priority: string;
  confidence: string;
  tags: string[];
  status: string;
}

export function normalizeMemoryInput(input: Record<string, unknown> = {}): NormalizedMemoryInput {
  const category = normalizeEnum(input.category, CATEGORIES, "lessons");
  const visibility = normalizeEnum(input.visibility, VISIBILITIES, "common");
  const scope = normalizeEnum(input.scope, SCOPES, category === "projects" ? "project" : "global");

  return {
    title: normalizeString(input.title || input.content || "Untitled memory"),
    body: normalizeString(input.body || input.content || ""),
    category,
    visibility,
    agent_id: normalizeString(input.agent_id, DEFAULT_AGENT_ID),
    scope,
    project_key: normalizeString(input.project_key),
    applies_to: asArray(input.applies_to),
    priority: normalizeEnum(input.priority, PRIORITIES, "normal"),
    confidence: normalizeEnum(input.confidence, CONFIDENCES, "working"),
    tags: asArray(input.tags),
    status: normalizeEnum(input.status, STATUSES, "active"),
  };
}

export function isProtectedCategory(category: string): boolean {
  return PROTECTED_CATEGORIES.has(category);
}
