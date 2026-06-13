// A tiny, dependency-light semver-ish comparison.
//
// We only need "is the installed version behind the latest release?" — not a
// full spec-compliant semver implementation. This tolerates the prerelease
// shapes the monorepo actually ships (`1.0.0`, `1.0.0-rc.2`, `v1.2.3`) and
// degrades gracefully on anything it can't parse (returns 0 → "equal", so an
// unparseable version is never reported as an update).
//
// Precedence rules (subset of semver §11):
//   - numeric release fields compare numerically (1.2.0 < 1.10.0);
//   - a version WITH a prerelease has LOWER precedence than the same version
//     WITHOUT one (1.0.0-rc.1 < 1.0.0);
//   - prerelease identifiers compare left-to-right; numeric identifiers
//     compare numerically, others lexically, numeric < non-numeric.

interface Parsed {
  release: number[];
  prerelease: string[];
}

/** Strip a leading `v` and any build-metadata (`+…`) we don't compare on. */
function parse(version: string): Parsed | null {
  const trimmed = version.trim().replace(/^v/i, "");
  if (!trimmed) return null;
  const [core, ...preParts] = trimmed.split("-");
  // Drop build metadata (`+sha`) from the prerelease tail and the core.
  const prerelease = preParts.join("-").split("+")[0] ?? "";
  const coreNoBuild = (core ?? "").split("+")[0] ?? "";
  const release = coreNoBuild.split(".").map((n) => Number.parseInt(n, 10));
  if (release.length === 0 || release.some((n) => Number.isNaN(n))) return null;
  return {
    release,
    prerelease: prerelease.length > 0 ? prerelease.split(".") : [],
  };
}

/**
 * Compare two version strings. Returns <0 if `a` precedes `b`, >0 if `a`
 * follows `b`, 0 if equal or either is unparseable (so an unknown version
 * never reads as "behind").
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  const len = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa.release[i] ?? 0;
    const db = pb.release[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }

  // Equal release fields → a version with a prerelease is LOWER than one
  // without (1.0.0-rc.1 < 1.0.0).
  const aPre = pa.prerelease.length > 0;
  const bPre = pb.prerelease.length > 0;
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (!aPre && !bPre) return 0;

  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    // A longer prerelease list (with all-else-equal prefixes) has higher
    // precedence (rc.1 < rc.1.1).
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

/**
 * True iff `installed` is strictly behind `latest`. Either side being unknown
 * (empty / unparseable) yields `false` — the caller renders `?`, never a
 * false "update available".
 */
export function isBehind(installed: string, latest: string): boolean {
  if (!installed || !latest) return false;
  return compareVersions(installed, latest) < 0;
}
