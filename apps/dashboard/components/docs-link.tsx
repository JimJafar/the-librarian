"use client";

import { usePathname } from "next/navigation";
import { docsUrlForPath } from "@/lib/docs-map";

// Contextual "Docs" deep-link in the top nav (docs-site spec, Phase 4 / OQ2).
// It opens the docs page for the CURRENT route — one global affordance that is
// also per-page contextual. It stays DARK (renders nothing) until
// NEXT_PUBLIC_DOCS_URL is set at go-live (OQ1), so the dashboard never offers a
// link to a docs site that isn't deployed yet. NEXT_PUBLIC_* is inlined at
// build, so flipping it on is a rebuild, not a code change.
export function DocsLink() {
  const pathname = usePathname() ?? "/";
  const href = docsUrlForPath(process.env.NEXT_PUBLIC_DOCS_URL, pathname);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Open the documentation for this page"
      className="px-2 py-1 text-sm text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
    >
      Docs
    </a>
  );
}
