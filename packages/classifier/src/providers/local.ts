// Local classifier provider — runs a GGUF model via node-llama-cpp on a
// worker thread to keep the mcp-server's event loop responsive (spec
// §4.2 + §4.3). The actual inference machinery is encapsulated behind
// `LocalInferenceClient` so the provider itself stays test-friendly: the
// production wiring builds a worker-backed client (see `./local.worker.ts`),
// tests inject an in-memory fake.

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

export interface LocalClassifierConfig {
  /** Model id — either a catalog id or a custom HF identifier (`org/name`). */
  modelId: string;
  /** Recommended quant from the catalog (or admin override). */
  quant?: string;
  /** Prompt template version. Defaults to `"v1"`. */
  promptVersion?: string;
}

/**
 * Minimal contract the provider depends on. One inference at a time
 * (matches the single-worker constraint in §4.1). The implementation
 * owns lifecycle — `infer()` can lazy-load the model on first call.
 *
 * `signal` lets the provider enforce its per-attempt timeout from the
 * caller side: if it fires before the worker responds, the provider
 * returns a `"timeout"` fallback. The worker may keep generating until
 * it notices and unwinds; that's fine — only one inference runs at a
 * time so there's no concurrent-request hazard.
 */
export interface LocalInferenceClient {
  infer(prompt: string, signal: AbortSignal): Promise<string>;
}

export interface LocalClassifierDeps {
  inference: LocalInferenceClient;
  now?: () => number;
}

export function createLocalClassifier(
  config: LocalClassifierConfig,
  deps: LocalClassifierDeps,
): Classifier {
  const now = deps.now ?? Date.now;
  const promptVersion = config.promptVersion ?? DEFAULT_PROMPT_VERSION;
  const template = loadPromptTemplate(promptVersion);

  return {
    async classify(input: ClassifyInput, opts: ClassifyOptions = {}): Promise<ClassifyResult> {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const start = now();
      const prompt = renderPrompt(template, input);

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort("timeout"), timeoutMs);

      let raw: string;
      try {
        raw = await deps.inference.infer(prompt, controller.signal);
      } catch {
        return fallback(start, controller.signal.aborted, promptVersion, config.modelId);
      } finally {
        clearTimeout(timeoutHandle);
      }

      const verdict = parseVerdict(raw);
      if (verdict === null) {
        return {
          verdict: { ...CONSERVATIVE_DEFAULTS },
          fallback_used: "parse",
          prompt_version: promptVersion,
          provider: "local",
          model: config.modelId,
          latency_ms: now() - start,
          raw_output: raw,
        };
      }

      return {
        verdict,
        prompt_version: promptVersion,
        provider: "local",
        model: config.modelId,
        latency_ms: now() - start,
        raw_output: raw,
      };
    },
  };

  function fallback(
    start: number,
    aborted: boolean,
    promptVersionUsed: string,
    modelUsed: string,
  ): ClassifyResult {
    const reason: ClassifierFallbackReason = aborted ? "timeout" : "provider_unavailable";
    return {
      verdict: { ...CONSERVATIVE_DEFAULTS },
      fallback_used: reason,
      prompt_version: promptVersionUsed,
      provider: "local",
      model: modelUsed,
      latency_ms: now() - start,
      raw_output: "",
    };
  }
}
