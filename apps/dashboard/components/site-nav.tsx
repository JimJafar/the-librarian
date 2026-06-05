"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { VersionBadge } from "@/components/version-badge";

// The dashboard's single persistent navigation. Mounted once in the root layout
// (app/layout.tsx) so every surface — Memories, Handoffs, the memories
// sub-views, and Curator — is reachable without the command palette. "Memories"
// matches the command-palette label for `/` (keyboard-host.tsx).
//
// Below the `md` breakpoint the tab list collapses behind a hamburger toggle so
// the bar fits on a phone-sized viewport; the right-hand controls (version
// badge, theme toggle, sign-out) stay visible at every width.
const TABS = [
  { href: "/", label: "Memories", match: (p: string) => p === "/" },
  { href: "/handoffs", label: "Handoffs", match: (p: string) => p.startsWith("/handoffs") },
  { href: "/analytics", label: "Analytics", match: (p: string) => p === "/analytics" },
  { href: "/proposals", label: "Proposals", match: (p: string) => p === "/proposals" },
  { href: "/archive", label: "Archive", match: (p: string) => p === "/archive" },
  { href: "/curator", label: "Curator", match: (p: string) => p.startsWith("/curator") },
  { href: "/backups", label: "Backups", match: (p: string) => p.startsWith("/backups") },
  { href: "/tokens", label: "Tokens", match: (p: string) => p.startsWith("/tokens") },
  { href: "/settings/auth", label: "Auth", match: (p: string) => p.startsWith("/settings/auth") },
] as const;

// Routes that render their own full-screen chrome and should NOT show the nav:
// the diagnostic health probe today, and the login page when auth lands.
function isChromeFree(pathname: string): boolean {
  // /settings/auth/reset is the one-time-link reset page — reached without a session,
  // so it renders chrome-free like /login (the /settings/auth wizard itself shows nav).
  return (
    pathname === "/health" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/settings/auth/reset")
  );
}

function tabClasses(active: boolean): string {
  return `rounded-md px-3 py-1.5 transition-colors ${
    active
      ? "bg-background text-foreground shadow-sm"
      : "text-muted-foreground hover:text-foreground"
  }`;
}

export function SiteNav({ signedIn = false }: { signedIn?: boolean }) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);

  // Auto-close the mobile menu on route change so a navigation gesture leaves
  // the next page in its default chrome state.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (isChromeFree(pathname)) return null;

  return (
    <nav className="border-b bg-muted/20 text-sm">
      <div className="flex items-center gap-1 px-4 py-2">
        <button
          type="button"
          aria-label={open ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={open}
          aria-controls="site-nav-mobile-menu"
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 mr-1 rounded-md p-1.5 text-muted-foreground hover:text-foreground md:hidden"
        >
          {/* Plain SVG icons — no extra dep. Hamburger / close. */}
          {open ? (
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          ) : (
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          )}
        </button>
        <div className="hidden flex-wrap items-center gap-1 md:flex">
          {TABS.map((tab) => {
            const active = tab.match(pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={tabClasses(active)}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        <span className="ml-auto flex items-center gap-1">
          <VersionBadge />
          <ThemeToggle />
          {signedIn ? <SignOutButton /> : null}
        </span>
      </div>
      {/*
        Mobile drawer: rendered below the bar when `open`, hidden above `md`.
        Each tab is a full-width target so it's tappable on a phone.
      */}
      {open ? (
        <div id="site-nav-mobile-menu" className="border-t bg-muted/40 px-2 py-2 md:hidden">
          <ul className="flex flex-col gap-1">
            {TABS.map((tab) => {
              const active = tab.match(pathname);
              return (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    className={`block ${tabClasses(active)}`}
                  >
                    {tab.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
