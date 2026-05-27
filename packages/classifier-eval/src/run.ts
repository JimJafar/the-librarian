// Core eval-run engine. `runEval()` drives a classifier through a
// sample of fixture entries and produces a report covering joint +
// per-boolean agreement, category-stratified disagreement, latency
// distribution, and the sample-level results the dashboard renders
// as a diff table.
//
// Determinism contract: with a fixed sample size, fixture, and seed
// the *sample composition* (`samples[].fixture_id` order) and the
// derived agreement/disagreement/fallback counts are identical. The
// `run_id` is a fresh UUID per call and `latency_ms` reflects the
// classifier's real timings — both deliberately not pinned.

import { randomUUID } from "node:crypto";
import type { Classifier, ClassifyResult } from "@librarian/classifier";
import type { FixtureEntry } from "./fixture.js";

export interface RunEvalOptions {
  fixture: readonly FixtureEntry[];
  /** Number of samples to draw. If `>= fixture.length`, runs the whole fixture. */
  sample: number;
  /** Filter to a single category, or `"all"`. */
  category: "all" | "straight" | "boundary";
  /** Random source (0..<1). Defaults to `Math.random`. Tests pass a seeded source. */
  random?: () => number;
}

export interface SampleResult {
  fixture_id: string;
  category: "straight" | "boundary";
  expected: { requires_approval: boolean; is_global: boolean };
  actual: { requires_approval: boolean; is_global: boolean };
  fallback_used: ClassifyResult["fallback_used"];
  latency_ms: number;
  /** Both booleans match expected. */
  joint_agree: boolean;
  raw_output: string;
}

export interface EvalReport {
  run_id: string;
  provider: ClassifyResult["provider"];
  model: string;
  prompt_version: string;
  sample_size: number;
  filter: "all" | "straight" | "boundary";
  agreement: {
    joint: number;
    requires_approval: number;
    is_global: number;
  };
  disagreement_by_category: {
    straight: { total: number; misses: number };
    boundary: { total: number; misses: number };
  };
  latency_ms: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  fallback_counts: Record<string, number>;
  samples: SampleResult[];
}

/**
 * Run an evaluation. Returns the report; never throws on classifier
 * failure (failures land in `samples[].fallback_used`).
 */
export async function runEval(classifier: Classifier, opts: RunEvalOptions): Promise<EvalReport> {
  const random = opts.random ?? Math.random;
  const filtered =
    opts.category === "all"
      ? opts.fixture
      : opts.fixture.filter((entry) => entry.category === opts.category);
  const sampleSize = Math.min(opts.sample, filtered.length);
  const drawn =
    opts.category === "all"
      ? stratifiedSample(filtered, sampleSize, random)
      : randomSample(filtered, sampleSize, random);

  const samples: SampleResult[] = [];
  let provider: ClassifyResult["provider"] = "none";
  let model = "unknown";
  let promptVersion = "v1";
  for (const entry of drawn) {
    const result = await classifier.classify({
      title: entry.title,
      body: entry.body,
      tags: entry.tags,
    });
    provider = result.provider;
    model = result.model;
    promptVersion = result.prompt_version;
    samples.push({
      fixture_id: entry.id,
      category: entry.category,
      expected: entry.label,
      actual: result.verdict,
      fallback_used: result.fallback_used,
      latency_ms: result.latency_ms,
      joint_agree:
        result.verdict.requires_approval === entry.label.requires_approval &&
        result.verdict.is_global === entry.label.is_global,
      raw_output: result.raw_output,
    });
  }

  return {
    run_id: `run_${randomUUID()}`,
    provider,
    model,
    prompt_version: promptVersion,
    sample_size: samples.length,
    filter: opts.category,
    agreement: agreementMetrics(samples),
    disagreement_by_category: disagreementByCategory(samples),
    latency_ms: latencyDistribution(samples),
    fallback_counts: fallbackCounts(samples),
    samples,
  };
}

/**
 * Stratified-random sample (spec §4.6): splits the source by category,
 * shuffles each stratum independently, draws a proportional count from
 * each. The draw count per stratum is `round(size * stratum / total)`;
 * remainder is allocated to whichever stratum's fractional part was
 * largest so the totals reconcile exactly to `size`.
 *
 * Deterministic given a seeded `random`. Tests rely on this.
 */
function stratifiedSample(
  source: readonly FixtureEntry[],
  size: number,
  random: () => number,
): FixtureEntry[] {
  if (size >= source.length) return [...source];
  const strata = new Map<FixtureEntry["category"], FixtureEntry[]>();
  for (const entry of source) {
    const bucket = strata.get(entry.category) ?? [];
    bucket.push(entry);
    strata.set(entry.category, bucket);
  }
  const total = source.length;
  // First pass: floor allocations + record fractional parts for the
  // remainder distribution. Sort by descending fractional so the
  // stratum that "deserves" the extra slot gets it first.
  const allocations: { category: FixtureEntry["category"]; count: number; frac: number }[] = [];
  let allocated = 0;
  for (const [category, bucket] of strata) {
    const ideal = (size * bucket.length) / total;
    const floor = Math.floor(ideal);
    allocations.push({ category, count: floor, frac: ideal - floor });
    allocated += floor;
  }
  allocations.sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (allocated < size && i < allocations.length) {
    allocations[i]!.count++;
    allocated++;
    i++;
  }
  const drawn: FixtureEntry[] = [];
  for (const allocation of allocations) {
    const bucket = strata.get(allocation.category) ?? [];
    drawn.push(...randomSample(bucket, allocation.count, random));
  }
  return drawn;
}

/** Plain random sample (no stratification): Fisher–Yates then slice. */
function randomSample(
  source: readonly FixtureEntry[],
  size: number,
  random: () => number,
): FixtureEntry[] {
  if (size >= source.length) return [...source];
  const shuffled = [...source];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = swap;
  }
  return shuffled.slice(0, size);
}

function agreementMetrics(samples: SampleResult[]): EvalReport["agreement"] {
  if (samples.length === 0) return { joint: 0, requires_approval: 0, is_global: 0 };
  let joint = 0;
  let ra = 0;
  let ig = 0;
  for (const s of samples) {
    if (s.joint_agree) joint++;
    if (s.actual.requires_approval === s.expected.requires_approval) ra++;
    if (s.actual.is_global === s.expected.is_global) ig++;
  }
  const n = samples.length;
  return { joint: joint / n, requires_approval: ra / n, is_global: ig / n };
}

function disagreementByCategory(samples: SampleResult[]): EvalReport["disagreement_by_category"] {
  const out = {
    straight: { total: 0, misses: 0 },
    boundary: { total: 0, misses: 0 },
  };
  for (const s of samples) {
    out[s.category].total++;
    if (!s.joint_agree) out[s.category].misses++;
  }
  return out;
}

function latencyDistribution(samples: SampleResult[]): EvalReport["latency_ms"] {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = samples.map((s) => s.latency_ms).sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

function fallbackCounts(samples: SampleResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of samples) {
    const reason = s.fallback_used;
    if (reason === undefined) continue;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}
