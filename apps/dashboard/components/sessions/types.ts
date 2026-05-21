import type { AppRouter } from "@librarian/mcp-server";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type SessionRouterInputs = inferRouterInputs<AppRouter>["sessions"];
export type SessionRouterOutputs = inferRouterOutputs<AppRouter>["sessions"];
export type SessionRow = SessionRouterOutputs["list"]["sessions"][number];

export const SESSION_STATUSES = ["active", "paused", "ended"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Stale = session is still active but hasn't been touched in over 7 days.
// Matches the legacy `STALE_SESSION_MS` constant in
// packages/mcp-server/public/app.js so the indicator triggers on the
// same row set the operators are used to.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function isStale(session: SessionRow): boolean {
  if (session.status !== "active") return false;
  const lastActivity = new Date(session.last_activity_at).getTime();
  if (!Number.isFinite(lastActivity)) return false;
  return Date.now() - lastActivity > STALE_AFTER_MS;
}
