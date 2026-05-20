import type { AppRouter } from "@librarian/mcp-server";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type SessionRouterInputs = inferRouterInputs<AppRouter>["sessions"];
export type SessionRouterOutputs = inferRouterOutputs<AppRouter>["sessions"];
export type SessionRow = SessionRouterOutputs["list"]["sessions"][number];

export const SESSION_STATUSES = ["active", "paused", "ended", "archived", "deleted"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Stale = session is still active but hasn't been touched in over 24h.
// Mirrors the legacy stale-indicator heuristic that flags abandoned
// sessions on the list view.
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isStale(session: SessionRow): boolean {
  if (session.status !== "active") return false;
  const lastActivity = new Date(session.last_activity_at).getTime();
  return Date.now() - lastActivity > STALE_AFTER_MS;
}
