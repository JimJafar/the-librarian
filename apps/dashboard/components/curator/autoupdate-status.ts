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

// Prerelease-aware comparison (subset of semver §11). The monorepo ships
// prerelease tags (`1.0.0-rc.29`, `1.0.0-rc.33`), so the comparison MUST look at
// the prerelease segment — an earlier version that dropped it compared
// `rc.29` and `rc.33` as equal (both `[1,0,0]`) and falsely reported
// "up to date". Mirrors `packages/installer-cli/src/semver.ts`; kept local so
// the client bundle doesn't pull a CLI module. Unparseable → `null` ("unknown"),
// so we never claim an update we couldn't confirm.
interface ParsedVersion {
  release: number[];
  prerelease: string[];
}

function parseSemver(value: string): ParsedVersion | null {
  const trimmed = value.trim().replace(/^v/i, "");
  if (!trimmed) return null;
  const [core, ...preParts] = trimmed.split("-");
  const prerelease = preParts.join("-").split("+")[0] ?? "";
  const coreNoBuild = (core ?? "").split("+")[0] ?? "";
  const release = coreNoBuild.split(".").map((n) => Number.parseInt(n, 10));
  if (release.length === 0 || release.some((n) => Number.isNaN(n))) return null;
  return { release, prerelease: prerelease.length > 0 ? prerelease.split(".") : [] };
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  const len = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < len; i++) {
    const av = pa.release[i] ?? 0;
    const bv = pb.release[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }

  // Equal release fields: a version WITH a prerelease ranks below one without
  // (1.0.0-rc.1 < 1.0.0); otherwise compare prerelease identifiers.
  const aPre = pa.prerelease.length > 0;
  const bPre = pb.prerelease.length > 0;
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (!aPre && !bPre) return 0;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    // A longer prerelease list (all-else-equal) ranks higher (rc.1 < rc.1.1).
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const ai = a[i] ?? "";
    const bi = b[i] ?? "";
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const na = Number.parseInt(ai, 10);
      const nb = Number.parseInt(bi, 10);
      if (na !== nb) return na < nb ? -1 : 1;
      continue;
    }
    if (an !== bn) return an ? -1 : 1; // numeric identifiers rank below alphanumeric
    if (ai !== bi) return ai < bi ? -1 : 1;
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
