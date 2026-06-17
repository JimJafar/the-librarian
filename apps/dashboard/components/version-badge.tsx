"use client";

import {
  type VersionStatus as Status,
  autoUpdateStatus as statusOf,
} from "@/components/curator/autoupdate-status";
import { trpc } from "@/lib/trpc-client";

// Status dot uses the brand palette — verdigris for up-to-date (positive),
// copper for behind (important but not destructive — same tier the
// RestartPrompt and the toggle-gate on /settings/backups use), and a
// neutral outlined dot for loading / unknown (matches the StatusStrip's
// off-state on /settings/auth).
const DOT_CLASS: Record<Status, string> = {
  loading: "border border-foreground/30 bg-transparent",
  up_to_date: "bg-ink-accent",
  behind: "bg-ink-copper",
  unknown: "border border-foreground/30 bg-transparent",
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
      className="inline-flex h-9 items-center gap-2 px-2 font-mono text-xs text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2 rounded-full ${DOT_CLASS[status]}`}
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
