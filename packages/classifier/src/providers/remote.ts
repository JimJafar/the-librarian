// Remote (OpenAI-compatible chat-completions) classifier provider.
//
// Reuses `@librarian/core/curator-llm-client`'s transport: bearer auth
// stays out of error messages, AbortController for timeouts, fetch
// injectable for tests. Per spec §4.2 the config namespace is
// `classifier.remote.*` — distinct from the curator's; admins keep
// them independently configurable.

import { LlmClientError, type LlmClient, type LlmCompletion } from "@librarian/core";
import { parseVerdict } from "../parse.js";
import { loadPromptTemplate, renderPrompt } from "../prompt.js";
import {
  CONSERVATIVE_DEFAULTS,
  type ClassifierFallbackReason,
  type ClassifyInput,
  type ClassifyResult,
} from "../types.js";
import type { Classifier, ClassifyOptions } from "./index.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_VERSION = "v1";

export interface RemoteClassifierConfig {
  /** Model id passed to the chat-completions API. */
  modelId: string;
  /** Prompt template version. Defaults to `"v1"`. */
  promptVersion?: string;
}

export interface RemoteClassifierDeps {
  /**
   * LLM client built by the caller (typically with the same factory
   * the memory curator uses). Tests pass a fake; the production wiring
   * builds one from `LlmClientConfig`.
   */
  llm: LlmClient;
  now?: () => number;
}

export function createRemoteClassifier(
  config: RemoteClassifierConfig,
  deps: RemoteClassifierDeps,
): Classifier {
  const now = deps.now ?? Date.now;
  const promptVersion = config.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const template = loadPromptTemplate(promptVersion);

  return {
    async classify(input: ClassifyInput, opts: ClassifyOptions = {}): Promise<ClassifyResult> {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const start = now();
      const userMessage = renderPrompt(template, input);

      let completion: LlmCompletion;
      try {
        completion = await deps.llm.complete({
          messages: [{ role: "user", content: userMessage }],
          jsonResponse: true,
          temperature: 0,
          timeoutMs,
        });
      } catch (err) {
        return fallback(start, err, promptVersion, config.modelId);
      }

      const verdict = parseVerdict(completion.content);
      if (verdict === null) {
        return {
          verdict: { ...CONSERVATIVE_DEFAULTS },
          fallback_used: "parse",
          prompt_version: promptVersion,
          provider: "remote",
          model: completion.model || config.modelId,
          latency_ms: now() - start,
        };
      }

      return {
        verdict,
        prompt_version: promptVersion,
        provider: "remote",
        model: completion.model || config.modelId,
        latency_ms: now() - start,
      };
    },
  };

  function fallback(
    start: number,
    err: unknown,
    promptVersionUsed: string,
    modelUsed: string,
  ): ClassifyResult {
    const reason = mapErrorToFallback(err);
    return {
      verdict: { ...CONSERVATIVE_DEFAULTS },
      fallback_used: reason,
      prompt_version: promptVersionUsed,
      provider: "remote",
      model: modelUsed,
      latency_ms: now() - start,
    };
  }
}

function mapErrorToFallback(err: unknown): ClassifierFallbackReason {
  if (err instanceof LlmClientError) {
    if (err.kind === "timeout") return "timeout";
    return "provider_unavailable";
  }
  return "provider_unavailable";
}
