// The stdio bin's caller {@link Principal} resolution (spec 061 T2), split out of
// `bin/stdio.ts` so it is unit-testable WITHOUT importing the bin (which self-executes:
// it opens a store and attaches stdin handlers at module load).

import { type Principal, SENTINEL_ACTOR_IDS, SYSTEM_ACTOR_IDS } from "@librarian/core";

/**
 * Resolve the stdio caller's {@link Principal} from the process environment (spec 061 T2).
 * Preserves today's role/id semantics exactly:
 *
 *   - `LIBRARIAN_STDIO_ROLE=admin` → the trusted admin actor. A set `LIBRARIAN_STDIO_AGENT_ID`
 *     is RETAINED as the admin's binding (both `actorId` and `boundActorId`) so `store_handoff`
 *     attributes `created_by_agent_id` to it, exactly as the old `{ role: "admin", agentId }`
 *     dispatch context did (spec 061 review fix 1). With no id, admin stays the `dashboard-admin`
 *     actor, unbound.
 *   - a set `LIBRARIAN_STDIO_AGENT_ID` (agent role) → that id in both `actorId` and `boundActorId`
 *     (so a mismatched body id still trips the impersonation guard, as it did when the id was
 *     passed as `authenticatedAgentId`).
 *   - nothing binds — an agent-role stdio caller with no configured id — → the `local-agent`
 *     sentinel (SC 3): stdio is a tokenless local process, the closest analogue of the localhost
 *     bypass, so its no-id fallback becomes that documented sentinel rather than the ambiguous
 *     `unknown-agent`. NO `boundActorId`: a sentinel is an attribution fallback, never a binding.
 */
export function resolveStdioPrincipal(env: NodeJS.ProcessEnv = process.env): Principal {
  const agentId = env.LIBRARIAN_STDIO_AGENT_ID?.trim();
  if (env.LIBRARIAN_STDIO_ROLE === "admin") {
    // Retain a configured id as the admin's cryptographic binding (fix 1) — mirrors the
    // bound-token pattern; keep `kind: "admin"` / `roles: ["admin"]` so authorisation is unchanged.
    if (agentId) {
      return { kind: "admin", actorId: agentId, boundActorId: agentId, roles: ["admin"] };
    }
    return { kind: "admin", actorId: SYSTEM_ACTOR_IDS.dashboardAdmin, roles: ["admin"] };
  }
  if (agentId) {
    return {
      kind: "agent",
      actorId: agentId,
      boundActorId: agentId,
      roles: ["agent"],
      scope: "agent",
    };
  }
  return { kind: "agent", actorId: SENTINEL_ACTOR_IDS.localhost, roles: ["agent"], scope: "agent" };
}
