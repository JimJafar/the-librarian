// Shared domain-resolution helper for the MCP tool handlers.
//
// `remember`, `recall`, and `start_session` all need to answer the same
// question: "given a tool call from an agent (or admin), what domain
// should this write/read be scoped to?" The precedence chain comes
// from memory-domain-isolation §4.10:
//
//   1. Admin role → null (bypasses the hard filter; admin sees all).
//   2. conv_id matches a `conversation_state` row → conv_state.domain.
//   3. Single-domain install (only one row in `domains`) → that domain.
//   4. Otherwise → null. Callers decide whether to translate null into
//      a defensive default (recall returns globals only) or an
//      outside-session route (remember opens a proposal).

import type { LibrarianStore } from "@librarian/core";
import type { ToolContext } from "./tool.js";

export type DomainSource = "admin" | "conv_state" | "single_domain" | "none";

export interface ResolvedDomain {
  domain: string | null;
  source: DomainSource;
}

export function resolveCallerDomain(
  store: LibrarianStore,
  convId: string,
  context: ToolContext,
): ResolvedDomain {
  if (context.role === "admin") return { domain: null, source: "admin" };
  if (convId) {
    const state = store.convState.get(convId);
    if (state) return { domain: state.domain, source: "conv_state" };
  }
  const rows = store.db.prepare("SELECT name FROM domains LIMIT 2").all() as Array<{
    name: string;
  }>;
  if (rows.length === 1) {
    return { domain: rows[0]?.name ?? null, source: "single_domain" };
  }
  return { domain: null, source: "none" };
}
