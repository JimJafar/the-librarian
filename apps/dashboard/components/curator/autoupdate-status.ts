// Shared running-version-vs-latest status logic (spec 2026-06-16-server-autoupdate
// T4). The top-bar VersionBadge and the auto-update settings panel both render an
// up-to-date / update-available indicator from a running version + a GitHub
// `LatestReleaseStatus`; this is the single source of truth for that comparison so
// the two never drift.

// Mirrors the `LatestReleaseStatus` union from
// `@librarian/mcp-server`'s github-release (the `autoupdate.get` / `health.info`
// `latest` field). Kept as a local structural type so the client bundle doesn't
// pull a server-only module just for a type.
export type LatestReleaseStatus =
  | {
      kind: "ok";
      release: { tag: string; htmlUrl?: string; publishedAt?: string };
      cachedAt: string;
    }
  | { kind: "no_release"; cachedAt: string }
  | { kind: "disabled" }
  | { kind: "unavailable"; reason: string };

export type VersionStatus = "loading" | "up_to_date" | "behind" | "unknown";

// Strip a leading `v` and split into numeric parts. Anything non-numeric becomes
// NaN, which `compareSemver` treats as "unknown" and falls back to "up to date"
// rather than risking a noisy false-positive.
function parseSemver(value: string): number[] {
  return value
    .replace(/^v/i, "")
    .split(/[-+.]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
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

// `current` vs the GitHub `latest` status → a coarse update state. `undefined`
// latest is the loading state (query not resolved); a non-`ok` latest (no
// release / disabled / unreachable) is "unknown" — conservative: never claim an
// update is available when we couldn't confirm one.
export function autoUpdateStatus(
  current: string,
  latest: LatestReleaseStatus | undefined,
): VersionStatus {
  if (!latest) return "loading";
  if (latest.kind !== "ok") return "unknown";
  const cmp = compareSemver(current, latest.release.tag);
  if (cmp === null) return "unknown";
  return cmp < 0 ? "behind" : "up_to_date";
}
