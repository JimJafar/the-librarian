"use client";

// The dashboard's brand presence at the layout shell — replaces the
// failed top-left tiny icon + the watermark behind everything that
// nobody could actually see. The librarian mark gets one earned home
// here, large enough to read at a glance, anchoring the left edge of
// the chrome on every page.
//
// Layout shape (md+):
//
//   ┌────────┬──────────────────────────────────────────────┐
//   │        │  Memories  Handoffs  Analytics  …            │
//   │  ⛬  ──┤  ───────────────────────────────────────────  │
//   │ figure │  Page heading  + page actions                │
//   │        │  …                                           │
//   └────────┴──────────────────────────────────────────────┘
//
// Below md the rail collapses to a small centred strip above the
// SiteNav so the brand stays visible without competing for the
// horizontal space mobile is already short on.
//
// `isChromeFree` is duplicated here from site-nav rather than imported
// because SiteNav owns the auth-routing knowledge; the brand chrome
// should follow the same routes-have-no-chrome rule, so when SiteNav
// returns null the rail does too.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LibrarianMark } from "@/components/brand/librarian-mark";

function isChromeFree(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/settings/auth/reset")
  );
}

export function BrandRail() {
  const pathname = usePathname() ?? "";
  if (isChromeFree(pathname)) return null;
  return (
    <>
      {/* Desktop: absolutely positioned at top-left so the figure
          floats over the chrome without claiming a full grid column —
          earlier versions reserved 112px for her and visibly shifted
          every page's content rightward. The layout's `md:pl-20`
          gives just enough left padding (80px) that the figure's body
          sits in empty space next to the nav and the page heading;
          only her rightmost ~16px overlaps the SiteNav's own `px-4`
          padding zone, never text. */}
      <aside
        aria-label="The Librarian"
        className="pointer-events-none absolute left-1 top-2 z-10 hidden md:flex"
      >
        <Link
          href="/"
          aria-label="The Librarian — home"
          className="pointer-events-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          <LibrarianMark size="rail" />
        </Link>
      </aside>
      {/* Mobile: small centred strip above the SiteNav. Subtle hairline
          below it so the brand strip reads as part of the chrome rather
          than floating in the content. */}
      <div className="flex items-center justify-center border-b border-ink-hairline px-4 py-2 md:hidden">
        <Link
          href="/"
          aria-label="The Librarian — home"
          className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          <LibrarianMark size="sidebar" />
        </Link>
      </div>
    </>
  );
}
