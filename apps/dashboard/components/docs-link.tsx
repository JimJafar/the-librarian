"use client";

import { usePathname } from "next/navigation";
import { DEFAULT_DOCS_URL, docsUrlForPath } from "@/lib/docs-map";

// Contextual "Docs" deep-link in the top nav (docs-site spec, Phase 4 / OQ2).
// It opens the docs page for the CURRENT route — one global affordance that is
// also per-page contextual. It defaults to the public docs site
// (DEFAULT_DOCS_URL), so every deployment gets the link with nothing to
// configure; NEXT_PUBLIC_DOCS_URL overrides the base for a private docs fork
// (NEXT_PUBLIC_* is inlined at build, so changing it is a rebuild).
export function DocsLink() {
  const pathname = usePathname() ?? "/";
  const href = docsUrlForPath(process.env.NEXT_PUBLIC_DOCS_URL || DEFAULT_DOCS_URL, pathname);
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
