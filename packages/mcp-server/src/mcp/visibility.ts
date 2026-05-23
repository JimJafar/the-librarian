// Role + visibility helpers shared across MCP tool handlers.
//
// Extracted from the pre-T4.2 dispatch.js. The rules are: admin sees
// everything; an agent sees common rows plus its own private rows. The
// `scopeAgentArgs` helper drops `admin` from caller input and (for agents)
// resolves `agent_id` to a single canonical actor id via the naming-contract
// resolver — normalising the supplied id, enforcing a mapped token's bound
// id (mismatch → reject, never silently overwrite), gating reserved
// namespaces, and falling back to the legacy sentinel while we run in
// soft-migration mode (spec §7.2 / §5.3).

import { DEFAULT_AGENT_ID, resolveCaller, type LibrarianStore } from "@librarian/core";
import type { ToolContext } from "./tool.js";

interface SessionLike {
  visibility: string;
  created_by_agent_id: string;
}

interface MemoryLike {
  status: string;
  visibility: string;
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
  const resolved = resolveCaller({
    role: "agent",
    rawAgentId: typeof args.agent_id === "string" ? args.agent_id : undefined,
    authenticatedAgentId: context.agentId,
    allowMissingDuringMigration: true,
  });
  scoped.agent_id = resolved.actor_id;
  return scoped;
}

export function isSessionVisible(
  session: SessionLike | null | undefined,
  context: ToolContext,
): boolean {
  if (!session) return false;
  if (context.role === "admin") return true;
  if (session.visibility === "common") return true;
  if (
    context.role === "agent" &&
    context.agentId &&
    session.created_by_agent_id === context.agentId
  ) {
    return true;
  }
  return false;
}

export function visibleResourceMemories<T extends MemoryLike>(
  store: LibrarianStore,
  context: ToolContext,
): T[] {
  const role = context.role || "agent";
  return (store.listAll({}) as T[])
    .filter((memory) => memory.status !== "archived")
    .filter((memory) => {
      if (role === "admin") return true;
      if (memory.visibility === "common") return true;
      return Boolean(context.agentId) && memory.agent_id === context.agentId;
    });
}

export function listVisibleProposals<T extends MemoryLike>(
  store: LibrarianStore,
  args: Record<string, unknown> = {},
  role: ToolContext["role"] = "agent",
): T[] {
  const agentId = (args.agent_id as string) || DEFAULT_AGENT_ID;
  return (
    store.listAll({
      status: "proposed",
      agent_id: role === "admin" ? "" : agentId,
    }) as T[]
  ).filter((memory) => {
    if (role === "admin") return true;
    if (memory.visibility === "common") return true;
    return memory.visibility === "agent_private" && memory.agent_id === agentId;
  });
}
