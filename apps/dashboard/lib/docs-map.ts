// Dashboard → docs deep-link map (docs-site spec, Phase 4 / T4.1–T4.2).
//
// Each dashboard route maps to the docs page that documents it. The slug is the
// docs site's content path (apps/docs/src/content/docs/<slug>.md), and the
// cross-surface guard in tests/docs-map.test.ts fails if any target stops
// resolving to a real page — so a docs rename can't silently 404 a deep-link.
//
// Derived from the canonical route table (spec 063): every route carrying a
// `docsSlug` contributes one entry. The Settings tour is a single page, so every
// `/settings/*` tab maps to the same `dashboard/settings` slug.

import { ROUTES } from "@/lib/routes";

export const ROUTE_DOCS_SLUG: Record<string, string> = Object.fromEntries(
  ROUTES.filter((r) => r.docsSlug).map((r) => [r.href, r.docsSlug as string]),
);

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

/** The public docs site — the default the dashboard "Docs" link points at, so
 *  every deployment gets the link with nothing to configure. An operator can
 *  override the base (e.g. a private docs fork) with NEXT_PUBLIC_DOCS_URL. */
export const DEFAULT_DOCS_URL = "https://librarian-docs.codeministry.net";

/** The absolute docs URL for a pathname, or null when called with an empty
 *  base. The dashboard's <DocsLink> defaults the base to DEFAULT_DOCS_URL and
 *  lets NEXT_PUBLIC_DOCS_URL override it, so this returns null only when given
 *  no base directly. */
export function docsUrlForPath(base: string | undefined, pathname: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/${docsSlugForPath(pathname)}/`;
}
