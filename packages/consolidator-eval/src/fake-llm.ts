// A deterministic LlmClient for the eval's own tests (drive navigate→judge→route
// without a model) and for operator dry-runs over recorded judgments. It returns
// a scripted judgment whenever its `match` substring appears in the request — the
// submission text is the natural key, since the judge prompt embeds it verbatim.

import type {
  ConsolidationJudgment,
  LlmClient,
  LlmCompletion,
  LlmCompletionRequest,
} from "@librarian/core";

export interface ScriptedJudgment {
  /** A substring that identifies the request (e.g. a snippet of the submission). */
  match: string;
  /** The judgment to return, serialized as the model's JSON content. */
  judgment: ConsolidationJudgment;
}

/**
 * Build a deterministic LlmClient from a script. The first entry whose `match`
 * appears in the concatenated request messages wins; an unmatched request throws
 * (a fixture with no scripted answer is a test-authoring error, not a silent
 * pass). To simulate a model returning garbage, pass `rawContent` for an entry.
 */
export function scriptedLlmClient(
  script: ScriptedJudgment[],
  options: { rawByMatch?: Record<string, string> } = {},
): LlmClient {
  return {
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      const haystack = request.messages.map((message) => message.content).join("\n");
      // rawByMatch wins over the scripted judgments: it lets a test simulate a
      // model returning garbage even for a submission that also has a judgment.
      const raw = Object.entries(options.rawByMatch ?? {}).find(([key]) => haystack.includes(key));
      if (raw) return { content: raw[1], model: "scripted", usage: null };
      const hit = script.find((entry) => haystack.includes(entry.match));
      if (!hit) throw new Error("scriptedLlmClient: no scripted judgment matches the request");
      return { content: JSON.stringify(hit.judgment), model: "scripted", usage: null };
    },
  };
}
