// The eval run engine. For each fixture entry it stands up an in-memory corpus,
// runs the real pipeline (navigate→judge→route) with an injected LlmClient, and
// scores the plan. Deterministic: the recall adapter ranks by lexical overlap
// (stable tie-break by corpus order), and the ToC carries the whole (small)
// corpus, so the judge always has every candidate available.
//
// Never throws on a model/judge failure — a thrown LLM client or an unparseable
// judgment lands as a graded miss, so one bad case can't abort the run (mirrors
// classifier-eval's contract).

import {
  type ConsolidationThresholds,
  type LlmClient,
  type Memory,
  judgeSubmission,
  navigateInbox,
} from "@librarian/core";
import type { ConsolidatorCorpusDoc, ConsolidatorFixtureEntry } from "./fixture.js";
import { type EvalReport, type SampleResult, scoreSample, summarize } from "./metrics.js";

export interface RunConsolidatorEvalOptions {
  fixture: ConsolidatorFixtureEntry[];
  llmClient: LlmClient;
  thresholds?: ConsolidationThresholds;
}

function corpusDocToMemory(doc: ConsolidatorCorpusDoc): Memory {
  return {
    id: doc.id,
    agent_id: "system-eval",
    title: doc.title,
    body: doc.body,
    status: "active",
    project_key: doc.project_key ?? null,
    priority: "normal",
    confidence: "working",
    tags: doc.tags,
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    recall_count: 0,
    usefulness_score: 0,
    is_global: false,
    requires_approval: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

// A deterministic stand-in for index recall: rank the corpus by lexical overlap
// with the query, stable on ties by original order.
function rankByOverlap(memories: Memory[], query: string): Memory[] {
  const queryTokens = tokenize(query);
  return memories
    .map((memory, index) => ({
      memory,
      index,
      score: overlap(queryTokens, tokenize(`${memory.title} ${memory.body}`)),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((ranked) => ranked.memory);
}

async function evaluateEntry(
  entry: ConsolidatorFixtureEntry,
  llmClient: LlmClient,
  thresholds: ConsolidationThresholds | undefined,
): Promise<SampleResult> {
  const memories = entry.corpus.map(corpusDocToMemory);
  const deps = {
    recall: async (query: string, limit: number) => rankByOverlap(memories, query).slice(0, limit),
    listActive: () => memories,
  };
  try {
    const evidence = await navigateInbox(entry.submission.text, deps);
    const result = await judgeSubmission(
      { submissionText: entry.submission.text, evidence },
      { llmClient, ...(thresholds ? { thresholds } : {}) },
    );
    return scoreSample(entry, result.plan ?? null, result.parseError);
  } catch (error) {
    return scoreSample(entry, null, (error as Error).message);
  }
}

export async function runConsolidatorEval(
  options: RunConsolidatorEvalOptions,
): Promise<EvalReport> {
  const samples: SampleResult[] = [];
  for (const entry of options.fixture) {
    samples.push(await evaluateEntry(entry, options.llmClient, options.thresholds));
  }
  return summarize(samples);
}
