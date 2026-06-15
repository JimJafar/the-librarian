"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { OPEN_SHORTCUTS_EVENT } from "@/components/keyboard-host";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { VersionBadge } from "@/components/version-badge";

// The dashboard's single persistent navigation. Mounted once in the root
// layout (app/layout.tsx) so every surface is reachable without the command
// palette.
//
// Top-level: the operational surfaces (Memories, Handoffs, etc.) + a
// "Settings" dropdown that holds the configuration sub-surfaces. There's no
// /settings route — the trigger only opens the menu; the children own the
// actual pages. On mobile (hamburger drawer), Settings appears as a section
// heading with its 5 children listed underneath.

const TABS = [
  { href: "/", label: "Memories", match: (p: string) => p === "/" },
  { href: "/handoffs", label: "Handoffs", match: (p: string) => p.startsWith("/handoffs") },
  { href: "/analytics", label: "Analytics", match: (p: string) => p === "/analytics" },
  { href: "/proposals", label: "Proposals", match: (p: string) => p === "/proposals" },
  { href: "/flagged", label: "Flagged", match: (p: string) => p === "/flagged" },
  { href: "/archive", label: "Archive", match: (p: string) => p === "/archive" },
  { href: "/curator", label: "Curator", match: (p: string) => p === "/curator" },
  { href: "/vault", label: "Vault", match: (p: string) => p.startsWith("/vault") },
] as const;

// Setup-flow order: secure access, teach the system, configure the curator,
// issue agent tokens, schedule backups.
const SETTINGS_ITEMS = [
  { href: "/settings/auth", label: "Auth" },
  { href: "/settings/primer", label: "Primer" },
  { href: "/settings/curator", label: "Curator" },
  { href: "/settings/tokens", label: "Tokens" },
  { href: "/settings/backups", label: "Backups" },
] as const;

function isSettingsActive(p: string): boolean {
  return p.startsWith("/settings/");
}

// Routes that render their own full-screen chrome and should NOT show the nav.
function isChromeFree(pathname: string): boolean {
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
          <SettingsMenu pathname={pathname} />
        </div>
        <span className="ml-auto flex items-center gap-1">
          <VersionBadge />
          <button
            type="button"
            aria-label="Show keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))}
            className="rounded-md px-2 py-1 font-mono text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
          >
            ?
          </button>
          <ThemeToggle />
          {signedIn ? <SignOutButton /> : null}
        </span>
      </div>
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
            <li className="mt-2 px-3 pt-2 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
              Settings
            </li>
            {SETTINGS_ITEMS.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`block ${tabClasses(active)}`}
                  >
                    {item.label}
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

function SettingsMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const active = isSettingsActive(pathname);

  // Close when the route changes (a child link click navigates away).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside click + Escape — same pattern as the FilterChips popover.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent | TouchEvent) {
      const node = wrapperRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={active ? "page" : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`${tabClasses(active)} inline-flex items-center gap-1`}
      >
        Settings
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Settings"
          className="absolute left-0 top-full z-30 mt-1 min-w-[10rem] border border-ink-hairline bg-background shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]"
        >
          <ul className="flex flex-col py-1">
            {SETTINGS_ITEMS.map((item) => {
              const childActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    role="menuitem"
                    aria-current={childActive ? "page" : undefined}
                    className={`block px-3 py-1.5 text-sm transition-colors ${
                      childActive
                        ? "bg-ink-accent/[0.06] text-foreground"
                        : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
