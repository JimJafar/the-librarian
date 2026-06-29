// Dashboard → docs deep-link map (docs-site spec, Phase 4 / T4.1–T4.2).
//
// Each dashboard route maps to the docs page that documents it. The slug is the
// docs site's content path (apps/docs/src/content/docs/<slug>.md), and the
// cross-surface guard in tests/docs-map.test.ts fails if any target stops
// resolving to a real page — so a docs rename can't silently 404 a deep-link.

export const ROUTE_DOCS_SLUG: Record<string, string> = {
  "/": "dashboard/vault",
  "/activity": "dashboard/activity",
  "/curator": "dashboard/curator",
  "/memories": "dashboard/memories",
  "/handoffs": "dashboard/handoffs",
  "/analytics": "dashboard/analytics",
  "/proposals": "dashboard/proposals",
  "/flagged": "dashboard/flagged",
  "/archive": "dashboard/archive",
  "/health": "dashboard/health",
  // The Settings tour is a single page; every tab deep-links to it.
  "/settings/dashboard": "dashboard/settings",
  "/settings/auth": "dashboard/settings",
  "/settings/primer": "dashboard/settings",
  "/settings/curator": "dashboard/settings",
  "/settings/tokens": "dashboard/settings",
  "/settings/connect": "dashboard/settings",
  "/settings/ingest": "dashboard/settings",
  "/settings/backups": "dashboard/settings",
};

// The "Using the dashboard" landing page — the fallback for any route without a
// more specific mapping.
const DOCS_FALLBACK_SLUG = "dashboard";

// Every distinct slug the dashboard can deep-link to (incl. the fallback) — the
// guard checks each resolves to a real docs page.
export const DOCS_SLUGS: string[] = [
  ...new Set([...Object.values(ROUTE_DOCS_SLUG), DOCS_FALLBACK_SLUG]),
];

/** The docs slug for a dashboard pathname. Falls back to dynamic-route prefixes
 *  (e.g. /handoffs/<id>) and finally the dashboard landing page. */
export function docsSlugForPath(pathname: string): string {
  const exact = ROUTE_DOCS_SLUG[pathname];
  if (exact) return exact;
  if (pathname.startsWith("/settings/")) return "dashboard/settings";
  if (pathname.startsWith("/handoffs")) return "dashboard/handoffs";
  return DOCS_FALLBACK_SLUG;
}

/** The absolute docs URL for a pathname, or null when no docs base is
 *  configured — so the in-dashboard "Docs" link stays dark until go-live points
 *  NEXT_PUBLIC_DOCS_URL at the deployed site (OQ1). */
export function docsUrlForPath(base: string | undefined, pathname: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/${docsSlugForPath(pathname)}/`;
}
