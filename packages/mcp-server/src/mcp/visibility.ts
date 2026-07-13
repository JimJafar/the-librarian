// Caller-scoping helpers shared across MCP tool handlers.
//
// Extracted from the pre-T4.2 dispatch.js. The agent-private vs common
// visibility split is gone (rethink D8 — one shared corpus); what remains is
// caller identity: the `scopeAgentArgs` helper drops `admin` from caller input
// and (for agents) resolves `agent_id` to a single canonical actor id via the
// naming-contract resolver — normalising the supplied id, enforcing a mapped
// token's bound id (mismatch → reject, never silently overwrite), gating
// reserved namespaces, and falling back to the legacy sentinel while we run in
// soft-migration mode (spec §7.2 / §5.3).

import { resolveCaller, type LibrarianStore } from "@librarian/core";
import type { ToolContext } from "./tool.js";

interface MemoryLike {
  status: string;
  agent_id: string;
  title: string;
  body: string;
}

export function scopeAgentArgs(
  args: Record<string, unknown> = {},
  context: ToolContext,
): Record<string, unknown> {
  const scoped: Record<string, unknown> = { ...args };
  delete scoped.admin;
  if (context.principal.roles.includes("admin")) {
    scoped.admin = true;
    return scoped;
  }
  // The load-bearing threading rule (spec 061 SC 4): the CRYPTOGRAPHIC binding
  // (`principal.boundActorId`) — and only that — is the resolver's `authenticatedAgentId`, so a
  // bound token's impersonation guard still fires on a mismatched body id while an unbound
  // (sentinel) principal never trips it. `principal.actorId` is the no-id fallback ONLY, which
  // for the two legacy unbound paths is the documented sentinel (`env-token-agent` /
  // `local-agent`) that supersedes `unknown-agent` (SC 3). No alias map yet — the Phase-3
  // backfill wires that later. A non-string `agent_id` is coerced to "absent" and so resolves
  // to that fallback; once hard-enforcement lands, a malformed (vs. absent) id should fail loudly.
  const resolved = resolveCaller({
    role: "agent",
    rawAgentId: typeof args.agent_id === "string" ? args.agent_id : undefined,
    authenticatedAgentId: context.principal.boundActorId,
    fallbackActorId: context.principal.actorId,
    allowMissingDuringMigration: true,
  });
  scoped.agent_id = resolved.actor_id;
  return scoped;
}

export function visibleResourceMemories<T extends MemoryLike>(
  store: LibrarianStore,
  context: ToolContext,
): T[] {
  // Section 4d.3 — memory visibility column dropped. Every active
  // memory is surfaced regardless of role; per-agent isolation, if
  // needed, must be enforced at the recall surface via tags.
  void context;
  return (store.listAll({}) as unknown as T[]).filter((memory) => memory.status !== "archived");
}
