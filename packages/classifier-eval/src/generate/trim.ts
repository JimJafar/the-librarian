// Ratio-preserving trim — given two buckets of accepted candidates
// (`straight` + `boundary`), return a slice of the target size that
// honours the requested boundary ratio. Drops surplus from whichever
// bucket overshoots. Pure function.

import type { FixtureEntry } from "../fixture.js";

export interface TrimTargets {
  /** Final desired total. */
  total: number;
  /** Fraction of total that should be category=boundary. */
  boundaryRatio: number;
}

export interface TrimResult {
  trimmed: FixtureEntry[];
  /** How many of each category survived (post-trim). */
  counts: { straight: number; boundary: number };
  /**
   * True when both per-category targets were met. False if either
   * bucket was short of its target after trim — the pipeline should
   * iterate more in that case.
   */
  targetsMet: boolean;
}

export function trimToTargets(
  straight: readonly FixtureEntry[],
  boundary: readonly FixtureEntry[],
  targets: TrimTargets,
): TrimResult {
  const boundaryTarget = Math.round(targets.total * targets.boundaryRatio);
  const straightTarget = targets.total - boundaryTarget;
  const takenStraight = straight.slice(0, straightTarget);
  const takenBoundary = boundary.slice(0, boundaryTarget);
  return {
    trimmed: [...takenStraight, ...takenBoundary],
    counts: { straight: takenStraight.length, boundary: takenBoundary.length },
    targetsMet: takenStraight.length === straightTarget && takenBoundary.length === boundaryTarget,
  };
}

/** Per-category target counts derived from total + ratio. */
export function targetCounts(targets: TrimTargets): { straight: number; boundary: number } {
  const boundary = Math.round(targets.total * targets.boundaryRatio);
  return { straight: targets.total - boundary, boundary };
}
