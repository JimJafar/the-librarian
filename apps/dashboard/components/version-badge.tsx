"use client";

import { trpc } from "@/lib/trpc-client";

// Strip a leading `v` and split into numeric parts. Anything non-numeric
// becomes NaN, which `compareSemver` treats as "unknown" and falls back to
// "up to date" rather than risking a noisy false-positive.
function parseSemver(value: string): number[] {
  return value
    .replace(/^v/i, "")
    .split(/[-+.]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
}

function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const av = pa[i];
    const bv = pb[i];
    if (av === undefined || bv === undefined || Number.isNaN(av) || Number.isNaN(bv)) {
      return null;
    }
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

type Status = "loading" | "up_to_date" | "behind" | "unknown";

function statusOf(
  current: string,
  latest: { kind: string; release?: { tag: string } } | undefined,
): Status {
  if (!latest) return "loading";
  if (latest.kind !== "ok" || !latest.release) return "unknown";
  const cmp = compareSemver(current, latest.release.tag);
  if (cmp === null) return "unknown";
  return cmp < 0 ? "behind" : "up_to_date";
}

const DOT_TONE: Record<Status, string> = {
  loading: "bg-muted-foreground/40",
  up_to_date: "bg-emerald-500",
  behind: "bg-amber-500",
  unknown: "bg-muted-foreground/40",
};

const RELEASES_URL = "https://github.com/JimJafar/the-librarian/releases";

export function VersionBadge() {
  const info = trpc.health.info.useQuery(undefined, {
    // Refresh every 30 minutes so a long-lived dashboard tab eventually
    // notices a new release without polling the server constantly.
    refetchInterval: 30 * 60 * 1000,
    staleTime: 30 * 60 * 1000,
  });

  const current = info.data?.version ?? "…";
  const latest = info.data?.latest;
  const status = statusOf(current, latest);

  const href =
    latest && latest.kind === "ok" && latest.release ? latest.release.htmlUrl : RELEASES_URL;

  const tooltip = buildTooltip(current, latest, status);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={tooltip}
      aria-label={tooltip}
      data-testid="version-badge"
      data-status={status}
      className="flex h-9 items-center gap-2 rounded-md border border-transparent px-2 font-mono text-xs text-muted-foreground hover:border-border hover:text-foreground"
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${DOT_TONE[status]}`}
      />
      <span>v{current}</span>
    </a>
  );
}

function buildTooltip(
  current: string,
  latest: { kind: string; release?: { tag: string; publishedAt?: string } } | undefined,
  status: Status,
): string {
  if (status === "loading") return `v${current} — checking for updates…`;
  if (status === "up_to_date") return `v${current} — up to date`;
  if (status === "behind" && latest?.release) {
    return `v${current} — ${latest.release.tag} available (click for release notes)`;
  }
  if (latest?.kind === "no_release") {
    return `v${current} — no published releases yet`;
  }
  if (latest?.kind === "disabled") {
    return `v${current} — update check disabled`;
  }
  return `v${current} — couldn't reach github.com (click to open releases)`;
}
