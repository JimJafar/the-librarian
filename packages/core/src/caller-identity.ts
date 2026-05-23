// Agent naming & caller-identity contract.
//
// Implements docs/specs/agent-naming-contract-spec.md: tokens authenticate,
// names identify. Every identity-bearing call resolves to one canonical actor
// id via `resolveCaller`, which normalises the supplied name (§4.2), applies
// configured aliases (§4.4), enforces reserved namespaces (§4.4/§6), and
// validates token binding / allowlists (§5.3).
//
// This module is pure: no I/O, no store access. The MCP / CLI / dashboard /
// scheduler layers call `resolveCaller` once at their trust boundary and pass
// the resulting `actor_id` down to the store.

import { DEFAULT_AGENT_ID } from "./constants.js";

const MAX_ID_LENGTH = 64;
// Generous slack over MAX_ID_LENGTH: lets legitimately punctuation-heavy raw
// names through to normalisation while rejecting megabyte-scale junk up front.
const MAX_RAW_LENGTH = 1024;

/** Caller roles recognised at the trust boundary. */
export type CallerRole = "agent" | "admin" | "system";

/**
 * Persisted kind of an actor. Broader than {@link CallerRole}: `cli` is a
 * distinct kind (a trusted local operator) even though it has no own role.
 */
export type ActorKind = "agent" | "admin" | "system" | "cli";

/** Canonical ids for non-human system actors (§6). */
export const SYSTEM_ACTOR_IDS = {
  memoryCurator: "system-memory-curator",
  scheduler: "system-scheduler",
  migration: "system-migration",
  dashboardAdmin: "dashboard-admin",
  cli: "cli",
} as const;

const SYSTEM_PREFIX = "system-";
const DASHBOARD_PREFIX = "dashboard-";
const CLI_ACTOR_ID = "cli";

/** A configured semantic alias map: normalised id → canonical id (§4.4). */
export type CallerAliasMap = Readonly<Record<string, string>>;

export interface ResolveCallerInput {
  /** Untrusted, model/request-body supplied id. Lowest trust. */
  rawAgentId?: string;
  /** Id bound to the bearer token, when the token maps to one agent. */
  authenticatedAgentId?: string;
  /** Id injected by a trusted wrapper/transport. Highest trust. */
  injectedAgentId?: string;
  role: CallerRole;
  /** Optional allowlist scoping which ids this token may act as. */
  allowedAgentIds?: string[];
  /** Configured semantic aliases (§4.4). */
  aliases?: CallerAliasMap;
  /**
   * Soft-migration escape hatch: when no identity is supplied, resolve to the
   * legacy `unknown-agent` sentinel instead of throwing. Off by default so new
   * (hard-mode) calls fail loudly.
   */
  allowMissingDuringMigration?: boolean;
}

export interface ResolvedCaller {
  actor_id: string;
  raw_id?: string;
  injected_id?: string;
  authenticated_id?: string;
  role: CallerRole;
  /** The pre-alias normalised id, set only when an alias actually fired. */
  alias_applied?: string;
}

/**
 * Collapse a free-form caller name to the canonical syntax
 * `^[a-z0-9]+(-[a-z0-9]+)*$` (§4.2). Punctuation and whitespace become
 * separators rather than being deleted, so `Claude Code`, `claude.code`, and
 * `claude_code` all collapse to `claude-code`. Throws on empty/overlong output.
 */
export function normaliseCallerId(raw: string): string {
  // Reject absurd input cheaply, before the Unicode/regex passes touch it —
  // the canonical max is 64, so anything past a generous slack is never valid.
  if (raw.length > MAX_RAW_LENGTH) {
    throw new Error(`agent_id is too long (>${MAX_RAW_LENGTH} chars before normalisation)`);
  }

  const value = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop combining marks
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!value) throw new Error("agent_id normalises to an empty value");
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(`agent_id is too long after normalisation (>${MAX_ID_LENGTH} chars)`);
  }
  return value;
}

/** Whether an id sits in a reserved namespace (`system-*`, `dashboard-*`, `cli`). */
export function isReservedId(id: string): boolean {
  return id.startsWith(SYSTEM_PREFIX) || id.startsWith(DASHBOARD_PREFIX) || id === CLI_ACTOR_ID;
}

/** Classify a canonical id into its persisted {@link ActorKind} (§6). */
export function actorKind(id: string): ActorKind {
  if (id.startsWith(SYSTEM_PREFIX)) return "system";
  if (id.startsWith(DASHBOARD_PREFIX)) return "admin";
  if (id === CLI_ACTOR_ID) return "cli";
  return "agent";
}

interface AliasResult {
  id: string;
  /** The input id, set only when it differed from the alias target. */
  appliedFrom?: string;
}

/**
 * Resolve a single alias hop (§4.4). Alias targets must themselves be valid
 * canonical ids, and chains/loops are rejected rather than followed recursively.
 */
function applyAlias(id: string, aliases: CallerAliasMap): AliasResult {
  const target = aliases[id];
  if (target === undefined) return { id };

  const canonicalTarget = normaliseCallerId(target);
  if (canonicalTarget === id) return { id }; // direct self-alias is a harmless no-op
  // Reject any target that is itself an alias key — this is the single-hop rule
  // that forbids chains (a→b→c) and loops (a→b→a), and also a second-hop
  // self-alias (a→b, b→b). We flatten by rejecting, never by recursing (§4.4).
  if (aliases[canonicalTarget] !== undefined) {
    throw new Error(
      `alias chain not allowed: ${id} -> ${canonicalTarget} -> ... (flatten the alias map)`,
    );
  }
  return { id: canonicalTarget, appliedFrom: id };
}

/** Reject reserved ids that the caller's role is not entitled to (§4.4/§6). */
function assertRoleMayUseId(id: string, role: CallerRole): void {
  if (id.startsWith(SYSTEM_PREFIX)) {
    if (role !== "system") {
      throw new Error(`reserved id "${id}" is only valid for system actors`);
    }
    return;
  }
  if (id.startsWith(DASHBOARD_PREFIX)) {
    if (role !== "admin") {
      throw new Error(`reserved id "${id}" is only valid for dashboard/admin actors`);
    }
    return;
  }
  if (id === CLI_ACTOR_ID && role === "agent") {
    throw new Error(`reserved id "${CLI_ACTOR_ID}" is not valid for ordinary agents`);
  }
}

/** A non-empty string is "supplied"; `undefined` and blank strings are not. */
function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function firstSupplied(...values: (string | undefined)[]): string | undefined {
  return values.find(hasValue);
}

/** Normalise then alias a raw id to its final canonical form (§4.2 + §4.4). */
function toCanonicalId(raw: string, aliases: CallerAliasMap): string {
  return applyAlias(normaliseCallerId(raw), aliases).id;
}

/**
 * Resolve a canonical caller from the available identity sources (§7.1).
 *
 * Precedence: a trusted injected id beats an untrusted request-body id, which
 * beats the token-bound id. The chosen id is normalised, aliased, checked
 * against any token binding / allowlist, and gated against reserved namespaces.
 * With no id at all this throws — unless `allowMissingDuringMigration` is set,
 * in which case it falls back to the legacy `unknown-agent` sentinel.
 */
export function resolveCaller(input: ResolveCallerInput): ResolvedCaller {
  const aliases = input.aliases ?? {};
  const candidate = firstSupplied(
    input.injectedAgentId,
    input.rawAgentId,
    input.authenticatedAgentId,
  );

  if (candidate === undefined) {
    if (input.allowMissingDuringMigration) {
      return { actor_id: DEFAULT_AGENT_ID, role: input.role };
    }
    throw new Error("caller identity is required (no injected, request, or token-bound id)");
  }

  const aliased = applyAlias(normaliseCallerId(candidate), aliases);
  const actorId = aliased.id;

  // Token binding: a token mapped to a specific agent may only act as that
  // agent (compared after normalisation + aliasing) — §5.3.
  if (hasValue(input.authenticatedAgentId)) {
    const boundId = toCanonicalId(input.authenticatedAgentId, aliases);
    if (actorId !== boundId) {
      throw new Error(
        `caller id "${actorId}" does not match token-bound id "${boundId}" (possible impersonation)`,
      );
    }
  }

  // Token allowlist: this token may only act as one of the listed ids — §5.3.
  if (input.allowedAgentIds && input.allowedAgentIds.length > 0) {
    const allowed = new Set(input.allowedAgentIds.map((id) => toCanonicalId(id, aliases)));
    if (!allowed.has(actorId)) {
      throw new Error(`caller id "${actorId}" is not in the token allowlist`);
    }
  }

  assertRoleMayUseId(actorId, input.role);

  // Build conditionally: under `exactOptionalPropertyTypes` an optional field
  // must be omitted rather than set to `undefined`.
  const resolved: ResolvedCaller = { actor_id: actorId, role: input.role };
  if (input.rawAgentId !== undefined) resolved.raw_id = input.rawAgentId;
  if (input.injectedAgentId !== undefined) resolved.injected_id = input.injectedAgentId;
  if (input.authenticatedAgentId !== undefined) {
    resolved.authenticated_id = input.authenticatedAgentId;
  }
  if (aliased.appliedFrom !== undefined) resolved.alias_applied = aliased.appliedFrom;
  return resolved;
}
