"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";

// The dashboard's single persistent navigation. Mounted once in the root layout
// (app/layout.tsx) so every surface — Memories, Sessions, Recall, the memories
// sub-views, and Curator — is reachable without the command palette. "Memories"
// matches the command-palette label for `/` (keyboard-host.tsx).
const TABS = [
  { href: "/", label: "Memories", match: (p: string) => p === "/" },
  { href: "/sessions", label: "Sessions", match: (p: string) => p.startsWith("/sessions") },
  { href: "/recall", label: "Recall", match: (p: string) => p === "/recall" },
  { href: "/analytics", label: "Analytics", match: (p: string) => p === "/analytics" },
  { href: "/proposals", label: "Proposals", match: (p: string) => p === "/proposals" },
  { href: "/archive", label: "Archive", match: (p: string) => p === "/archive" },
  { href: "/logs", label: "Logs", match: (p: string) => p === "/logs" },
  { href: "/curator", label: "Curator", match: (p: string) => p.startsWith("/curator") },
] as const;

// Routes that render their own full-screen chrome and should NOT show the nav:
// the diagnostic health probe today, and the login page when auth lands.
function isChromeFree(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/login");
}

export function SiteNav() {
  const pathname = usePathname() ?? "";
  if (isChromeFree(pathname)) return null;
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b bg-muted/20 px-4 py-2 text-sm">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
      <span className="ml-auto">
        <ThemeToggle />
      </span>
    </nav>
  );
}
