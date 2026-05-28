// Orchestrator for the §4.7 public-fixture generation pipeline.
//
// Pure logic (no HTTP) — the LLM-facing dependencies arrive as injected
// async functions so the CLI can wire them to real `createCuratorLlmClient`
// instances, while tests pass in-memory stubs. `runFixtureGenerator`
// returns the final `FixtureFile` or throws when budget / iteration caps
// are exhausted before the targets are met.

import { randomUUID } from "node:crypto";
import { parseVerdict, type ClassifierVerdict } from "@librarian/classifier";
import type { FixtureEntry } from "../fixture.js";
import { consensusVerdict } from "./consensus.js";
import type { GeneratorBatchSpec } from "./prompts.js";
import { buildGeneratorPrompt, buildGraderPrompt } from "./prompts.js";
import { targetCounts, trimToTargets } from "./trim.js";
import type { PipelineLogEvent, PipelineOptions } from "./types.js";

/** A candidate as it leaves the generator — no id, no consensus models. */
export interface RawCandidate {
  title: string;
  body: string;
  tags: string[];
  label: ClassifierVerdict;
  category: FixtureEntry["category"];
}

/**
 * What the orchestrator needs from the outside world. Tests inject
 * fakes; the CLI wires these to real HTTP-backed LLM clients.
 */
export interface PipelineClients {
  /** Run one generator-prompt completion. Returns the raw model text. */
  generate: (prompt: string) => Promise<string>;
  /** Run one grader-prompt completion against `graderIndex`'s endpoint. */
  grade: (graderIndex: number, prompt: string) => Promise<string>;
}

export interface PipelineResult {
  fixture: FixtureEntry[];
  iterations: number;
  apiCalls: number;
}

export async function runFixtureGenerator(
  clients: PipelineClients,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const { config, targets, budget, candidatesPerBatch, maxIterations } = opts;
  const goals = targetCounts(targets);
  const graderNames = config.graders.map((g) => g.name);
  const survivors: { straight: FixtureEntry[]; boundary: FixtureEntry[] } = {
    straight: [],
    boundary: [],
  };
  let apiCalls = 0;
  let iteration = 0;
  const log = (event: PipelineLogEvent): void => opts.log?.(event);

  const checkBudget = (): void => {
    if (apiCalls > budget.maxCalls) {
      throw new Error(
        `budget exhausted (max ${budget.maxCalls} API calls); have ` +
          `${survivors.straight.length}/${goals.straight} straight + ` +
          `${survivors.boundary.length}/${goals.boundary} boundary`,
      );
    }
  };

  while (
    iteration < maxIterations &&
    (survivors.straight.length < goals.straight || survivors.boundary.length < goals.boundary)
  ) {
    iteration++;
    log({
      event: "iteration",
      iteration,
      haveStraight: survivors.straight.length,
      haveBoundary: survivors.boundary.length,
    });

    // Adapt batch composition: if one bucket is full, request only
    // the other category from the next batch.
    const stillNeedStraight = survivors.straight.length < goals.straight;
    const stillNeedBoundary = survivors.boundary.length < goals.boundary;
    let boundaryRatio: number;
    if (stillNeedStraight && stillNeedBoundary) boundaryRatio = targets.boundaryRatio;
    else if (stillNeedBoundary) boundaryRatio = 1;
    else boundaryRatio = 0;
    const spec: GeneratorBatchSpec = { totalCount: candidatesPerBatch, boundaryRatio };

    const prompt = buildGeneratorPrompt(spec);
    const raw = await clients.generate(prompt);
    apiCalls++;
    checkBudget();
    const candidates = parseGeneratorOutput(raw);
    log({
      event: "batch_generated",
      iteration,
      candidates: candidates.length,
      callCount: apiCalls,
    });

    for (const candidate of candidates) {
      // Skip categories that are already full so we don't waste grader
      // calls on the bucket that's done.
      const bucketFull =
        candidate.category === "straight"
          ? survivors.straight.length >= goals.straight
          : survivors.boundary.length >= goals.boundary;
      if (bucketFull) continue;

      const graderPrompt = buildGraderPrompt(candidate);
      const votes: (ClassifierVerdict | null)[] = [];
      for (let i = 0; i < config.graders.length; i++) {
        const graderOutput = await clients.grade(i, graderPrompt);
        apiCalls++;
        votes.push(parseVerdict(graderOutput));
        checkBudget();
      }
      const consensus = consensusVerdict(votes);
      if (consensus.verdict === null) {
        log({ event: "candidate_dropped", reason: consensus.reason, callCount: apiCalls });
        continue;
      }

      const entry: FixtureEntry = {
        id: `fix_${randomUUID()}`,
        title: candidate.title,
        body: candidate.body,
        tags: candidate.tags,
        // The graders' consensus IS the ground truth — overrides
        // whatever the generator claimed.
        label: consensus.verdict,
        category: candidate.category,
        consensus_models: graderNames,
      };
      survivors[candidate.category].push(entry);
      log({ event: "candidate_kept", verdict: consensus.verdict, callCount: apiCalls });
    }
  }

  const trim = trimToTargets(survivors.straight, survivors.boundary, targets);
  if (!trim.targetsMet) {
    throw new Error(
      `iteration cap reached (${iteration}/${maxIterations}) before targets met; ` +
        `have ${trim.counts.straight}/${goals.straight} straight + ` +
        `${trim.counts.boundary}/${goals.boundary} boundary after ${apiCalls} API calls`,
    );
  }

  log({ event: "done", iterations: iteration, calls: apiCalls });
  return { fixture: trim.trimmed, iterations: iteration, apiCalls };
}

/**
 * Parse the generator's raw text into structured candidates. The
 * generator is asked to return a JSON array; in practice models
 * sometimes wrap it in code fences or preamble. Strip both and
 * validate against the candidate schema; malformed candidates are
 * silently dropped (the generator will produce more next batch).
 */
export function parseGeneratorOutput(raw: string): RawCandidate[] {
  const json = extractJsonArray(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: RawCandidate[] = [];
  for (const item of parsed) {
    const candidate = validateCandidate(item);
    if (candidate) result.push(candidate);
  }
  return result;
}

function extractJsonArray(text: string): string | null {
  // Find the first '[' and the last ']' — tolerant of preamble + code
  // fences + trailing prose. Doesn't validate nesting; JSON.parse
  // does that downstream.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function validateCandidate(item: unknown): RawCandidate | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.title !== "string" || obj.title.length === 0) return null;
  if (typeof obj.body !== "string" || obj.body.length === 0) return null;
  if (obj.category !== "straight" && obj.category !== "boundary") return null;
  const label = obj.label;
  if (typeof label !== "object" || label === null) return null;
  const l = label as Record<string, unknown>;
  if (typeof l.requires_approval !== "boolean" || typeof l.is_global !== "boolean") return null;
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t) => typeof t === "string") : [];
  return {
    title: obj.title,
    body: obj.body,
    tags: tags as string[],
    label: { requires_approval: l.requires_approval, is_global: l.is_global },
    category: obj.category,
  };
}
