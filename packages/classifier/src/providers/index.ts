// Provider router — dispatches classify() to the configured provider.
//
// Section 4a ships the `remote` provider only. The `local` provider
// (node-llama-cpp) lands in Section 4b. The router lives at this seam
// so the worker code path is provider-agnostic from day one.

import { CONSERVATIVE_DEFAULTS, type ClassifyInput, type ClassifyResult } from "../types.js";
import {
  createRemoteClassifier,
  type RemoteClassifierConfig,
  type RemoteClassifierDeps,
} from "./remote.js";

/**
 * Provider config discriminated union. `provider === "local"` is
 * declared here so the router types stay forward-compatible with
 * Section 4b, but local config is unimplemented until then.
 */
export type ProviderConfig =
  | (RemoteClassifierConfig & { provider: "remote" })
  | { provider: "local"; modelId: string; promptVersion?: string };

export interface ClassifyOptions {
  /** Per-attempt timeout (ms). Defaults to 30s per spec §4.1. */
  timeoutMs?: number;
}

/**
 * Dependency-injectable factory: callers pass an LLM client (for
 * `remote`) and a clock (for `latency_ms` measurement). Lets tests
 * swap both without touching the network.
 */
export interface ClassifierFactoryDeps extends RemoteClassifierDeps {
  now?: () => number;
}

export interface Classifier {
  classify(input: ClassifyInput, opts?: ClassifyOptions): Promise<ClassifyResult>;
}

export function createClassifier(config: ProviderConfig, deps: ClassifierFactoryDeps): Classifier {
  if (config.provider === "remote") {
    return createRemoteClassifier(config, deps);
  }
  // Local provider lands in Section 4b. For now return a stub that
  // produces a conservative-defaults verdict so callers can wire the
  // worker without crashing during the 4a→4b interregnum.
  return {
    async classify() {
      const now = deps.now ?? Date.now;
      const start = now();
      return {
        verdict: { ...CONSERVATIVE_DEFAULTS },
        fallback_used: "provider_unavailable",
        prompt_version: config.promptVersion ?? "v1",
        provider: "none",
        model: config.modelId,
        latency_ms: now() - start,
      };
    },
  };
}
