// Curator (grooming) LLM-usage aggregation for the analytics page. Pure +
// unit-tested. Token usage is the one genuinely interesting LLM stat the system
// captures: each curation run records its input/output tokens and the model it
// used (recall-frequency stats were retired in D16 — recall is no longer
// counted — so there is no "recalls over time" to chart).

export interface CuratorRunLike {
  status: string;
  model_name?: string | null;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
}

export interface ModelUsage {
  model: string;
  tokens: number;
  runs: number;
}

export interface CuratorUsage {
  /** Runs in the window (newest ≤200 grooming runs). */
  runs: number;
  /** Of those, how many completed (vs skipped/failed/pending). */
  completed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Token spend grouped by model, largest first. */
  byModel: ModelUsage[];
}

export function summariseCuratorUsage(runs: readonly CuratorRunLike[]): CuratorUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let completed = 0;
  const models = new Map<string, { tokens: number; runs: number }>();

  for (const run of runs) {
    const input = run.usage_input_tokens ?? 0;
    const output = run.usage_output_tokens ?? 0;
    inputTokens += input;
    outputTokens += output;
    if (run.status === "completed") completed += 1;

    const model = run.model_name?.trim() || "unknown";
    const prev = models.get(model) ?? { tokens: 0, runs: 0 };
    models.set(model, { tokens: prev.tokens + input + output, runs: prev.runs + 1 });
  }

  const byModel = [...models.entries()]
    .map(([model, v]) => ({ model, tokens: v.tokens, runs: v.runs }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    runs: runs.length,
    completed,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    byModel,
  };
}
