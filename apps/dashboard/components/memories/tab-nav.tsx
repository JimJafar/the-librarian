"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Browse", match: (p: string) => p === "/" },
  { href: "/sessions", label: "Sessions", match: (p: string) => p.startsWith("/sessions") },
  { href: "/analytics", label: "Analytics", match: (p: string) => p === "/analytics" },
  { href: "/proposals", label: "Proposals", match: (p: string) => p === "/proposals" },
  { href: "/conflicts", label: "Conflicts", match: (p: string) => p === "/conflicts" },
  { href: "/archive", label: "Archive", match: (p: string) => p === "/archive" },
  { href: "/logs", label: "Logs", match: (p: string) => p === "/logs" },
] as const;

export function TabNav() {
  const pathname = usePathname();
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
    </nav>
  );
}
