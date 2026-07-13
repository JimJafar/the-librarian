// Agent naming & caller-identity contract.
//
// Implements docs/specs/done/011-agent-naming-contract-spec.md: tokens authenticate,
// names identify. Every identity-bearing call resolves to one canonical actor
// id via `resolveCaller`, which normalises the supplied name (§4.2), applies
// configured aliases (§4.4), enforces reserved namespaces (§4.4/§6), and
// validates token binding / allowlists (§5.3).
//
// This module is pure: no I/O, no store access. The MCP / CLI / dashboard /
// scheduler layers call `resolveCaller` once at their trust boundary and pass
// the resulting `actor_id` down to the store.

import type { TokenScope } from "./auth/agent-tokens.js";
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

/**
 * Sentinel actor ids for the two legacy authenticated-but-UNBOUND request paths
 * (spec 061 §6 — names decided by Jim, 2026-07-12, PERMANENT once written to vaults).
 *
 * These are the resolved {@link Principal.actorId} for credentials that authenticate a
 * request without cryptographically binding it to one agent. Which path produces each:
 *
 *   - `envToken` = `env-token-agent` — the shared env single-token path
 *     (`LIBRARIAN_AGENT_TOKEN`, `auth.ts` `resolveAgent`'s agentId-less match): one token
 *     many agents share, so it names none of them.
 *   - `localhost` = `local-agent` — BOTH the localhost no-auth bypass (`auth.ts`'s
 *     `allowNoAuth` branch, a tokenless local-dev caller) AND the stdio bin invoked with no
 *     agent id (`bin/stdio.ts`), which have the same "trusted-but-anonymous local caller"
 *     shape.
 *
 * Contract (spec 061 SC 1/SC 3), load-bearing:
 *   - They are `agent`-kind sentinels, NOT reserved system ids, so they normalise/classify as
 *     ordinary agents (`actorKind` → `"agent"`).
 *   - They NEVER appear as {@link Principal.boundActorId}: a sentinel is an attribution
 *     fallback, not a credential binding, so it must never masquerade as one — otherwise
 *     {@link resolveCaller}'s impersonation guard would fire for every self-identifying
 *     single-token agent. A body-supplied `agent_id` therefore continues to WIN over the
 *     sentinel (precedence order unchanged: injected > raw body > token-bound), exactly as it
 *     did before — the sentinel is only the fallback when nothing else resolves.
 *   - Where a {@link Principal} exists, they REPLACE the legacy `unknown-agent` fallback as the
 *     no-id attribution actor in persisted frontmatter (via {@link ResolveCallerInput.fallbackActorId}).
 *     This is the ONE deliberate, OSS-visible attribution change in spec 061 (SC 3, ADR 0011's
 *     "unknown-agent ambiguity replaced" consequence — signed off by Jim 2026-07-12); every other
 *     caller keeps `unknown-agent` (no principal, no fallback). Existing vault files are untouched.
 */
export const SENTINEL_ACTOR_IDS = {
  /** The env single-token path (`LIBRARIAN_AGENT_TOKEN`): a shared token that binds no agent. */
  envToken: "env-token-agent",
  /** The localhost no-auth bypass (and the stdio bin with no id): a tokenless local caller. */
  localhost: "local-agent",
} as const;

/**
 * The one identity currency threaded from listener to store write (ADR 0011 §4, spec 061
 * SC 1). Collapses today's four identity shapes (`AuthResult`, `ToolContext`'s role/agentId
 * pair, the tRPC role, `ResolvedCaller`) behind a single, provider-produced value.
 *
 * The `actorId`/`boundActorId` split is the design's spine:
 *   - `actorId` — ALWAYS present and NON-EMPTY: the resolved actor used for attribution
 *     (frontmatter `agent_id`). For unbound paths it is a fallback/sentinel
 *     ({@link SENTINEL_ACTOR_IDS}). A provider MUST supply a non-empty string — an empty
 *     `actorId` is a contract violation, not a legal "anonymous" value (use a sentinel for
 *     anonymity). The OSS code paths are type- and shape-test-enforced never to yield one (SC 3).
 *   - `boundActorId` — present ONLY when a credential cryptographically binds an identity
 *     (the per-agent token map, DB-minted `lib.<id>.…` tokens). It is what
 *     {@link resolveCaller} receives as its `authenticatedAgentId`, so its impersonation
 *     guard throws when a body-claimed id disagrees with a *binding*. A sentinel/fallback
 *     actor must therefore NEVER surface as `boundActorId` — doing so would make every
 *     self-identifying single-token agent trip that guard.
 *
 * `kind` is an OPEN string union — authorisation reads `roles`, not `kind`, so a plugin
 * introduces `member`/`curator` without an upstream enum edit. `scope`/`tokenId` mirror
 * the mcp-server `AuthResult` fields' types. `attrs` is opaque to OSS (free-form strings
 * for v1, spec 061 §6): a member-aware provider carries `memberId` there; core never reads it.
 */
export interface Principal {
  kind: "admin" | "agent" | "system" | (string & {});
  actorId: string;
  boundActorId?: string;
  roles: readonly string[];
  scope?: TokenScope;
  tokenId?: string;
  attrs?: Readonly<Record<string, string>>;
}

const SYSTEM_PREFIX = "system-";
const DASHBOARD_PREFIX = "dashboard-";
const CLI_ACTOR_ID = "cli";

/** A configured semantic alias map: normalised id → canonical id (§4.4). */
export type CallerAliasMap = Readonly<Record<string, string>>;

export interface ResolveCallerInput {
  // The three id sources explicitly admit `undefined`: callers at trust
  // boundaries (MCP/CLI/dashboard) routinely hold an optional id and shouldn't
  // have to conditionally omit the key under `exactOptionalPropertyTypes`.
  /** Untrusted, model/request-body supplied id. Lowest trust. */
  rawAgentId?: string | undefined;
  /** Id bound to the bearer token, when the token maps to one agent. */
  authenticatedAgentId?: string | undefined;
  /** Id injected by a trusted wrapper/transport. Highest trust. */
  injectedAgentId?: string | undefined;
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
  /**
   * The actor to attribute when NO id resolves (no injected, raw, or token-bound id) — spec
   * 061 SC 3/SC 4. Supersedes the `unknown-agent` fallback ONLY inside the
   * {@link allowMissingDuringMigration} branch, so a caller that holds a provider-produced
   * {@link Principal} threads its `actorId` (the documented sentinel — `env-token-agent` /
   * `local-agent` — for the two legacy unbound paths) here instead of the ambiguous
   * `unknown-agent`. Omitted by every other caller, so core's default when nothing resolves
   * stays `unknown-agent` (no exported behaviour change off the principal path).
   */
  fallbackActorId?: string;
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

/**
 * Classify a canonical id into its persisted {@link ActorKind} (§6). The legacy
 * `unknown-agent` sentinel falls through to `"agent"` — it has no kind of its
 * own; the dashboard surfaces it as legacy/unattributed by id, not by kind (§7.5).
 */
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

/**
 * Normalise then alias a raw id to its final canonical form (§4.2 + §4.4).
 * Exported for the Phase-3 backfill, which computes canonical targets for
 * stored ids using a one-time backfill alias map (§9).
 */
export function toCanonicalId(raw: string, aliases: CallerAliasMap): string {
  return applyAlias(normaliseCallerId(raw), aliases).id;
}

/**
 * Resolve a canonical caller from the available identity sources (§7.1).
 *
 * Precedence: a trusted injected id beats an untrusted request-body id, which
 * beats the token-bound id. The chosen id is normalised, aliased, checked
 * against any token binding / allowlist, and gated against reserved namespaces.
 * With no id at all this throws — unless `allowMissingDuringMigration` is set,
 * in which case it falls back to {@link ResolveCallerInput.fallbackActorId} (a
 * provider-produced sentinel, spec 061 SC 3) or the legacy `unknown-agent` sentinel.
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
      // Canonicalise a provider-supplied fallback the SAME way bound/body ids are (colon→dash,
      // case-fold — spec 061 review fix 4), so an unbound `member:sarah` actor persists as
      // `member-sarah` rather than splitting one actor across `member-sarah` / `member:sarah`.
      // Sentinels / `dashboard-admin` / `unknown-agent` are already canonical (no-op). An empty
      // (contract-violating) fallback is left AS-IS — the recorded doc-only violation, never
      // canonicalised (would throw) nor validated.
      const fallback = input.fallbackActorId;
      const actor_id = hasValue(fallback)
        ? normaliseCallerId(fallback)
        : (fallback ?? DEFAULT_AGENT_ID);
      return { actor_id, role: input.role };
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
