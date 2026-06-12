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
  if (context.role === "admin") {
    scoped.admin = true;
    return scoped;
  }
  // No alias map yet — applying `bede → guybrush` etc. is a Phase-3 backfill
  // concern and is wired in a later increment. A non-string `agent_id` is
  // coerced to "absent" and so resolves to the soft-mode sentinel; once
  // hard-enforcement lands, a malformed (vs. absent) id should fail loudly.
  const resolved = resolveCaller({
    role: "agent",
    rawAgentId: typeof args.agent_id === "string" ? args.agent_id : undefined,
    authenticatedAgentId: context.agentId,
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
  return (store.listAll({}) as T[]).filter((memory) => memory.status !== "archived");
}
