export const CATEGORIES = [
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

export const PROTECTED_CATEGORIES = new Set(["identity", "relationship"]);

export const VISIBILITIES = ["common", "agent_private"];
export const SCOPES = ["global", "project", "environment", "tool", "session"];
export const STATUSES = ["active", "proposed", "conflicted", "archived", "deleted", "rejected"];
export const PRIORITIES = ["low", "normal", "high", "core"];
export const CONFIDENCES = ["tentative", "working", "strong"];

export const SESSION_STATUSES = ["active", "paused", "ended", "archived", "deleted"];
export const SESSION_CAPTURE_MODES = ["off", "summary", "log"];
export const SESSION_EVENT_TYPES = [
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
export const SESSION_PAYLOAD_TYPES = [
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

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === "") return [];
  return [String(value)];
}

export function normalizeString(value, fallback = "") {
  if (value == null) return fallback;
  return String(value).trim();
}

export function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value, fallback);
  return allowed.includes(normalized) ? normalized : fallback;
}

export function normalizeMemoryInput(input = {}) {
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

export function isProtectedCategory(category) {
  return PROTECTED_CATEGORIES.has(category);
}
