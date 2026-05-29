// Provider router — constructs the classify() implementation.
//
// One provider ships: `remote` (OpenAI-compatible HTTP, spec §4.2). This
// also covers self-hosted models — point the endpoint at a local
// ollama / vllm / llama.cpp server URL.

import type { ClassifyInput, ClassifyResult } from "../types.js";
import {
  createRemoteClassifier,
  type RemoteClassifierConfig,
  type RemoteClassifierDeps,
} from "./remote.js";

/**
 * Provider config. Carries the model id + optional prompt version;
 * transport details flow through `RemoteClassifierDeps`.
 */
export type ProviderConfig = RemoteClassifierConfig & { provider: "remote" };

export interface ClassifyOptions {
  /** Per-attempt timeout (ms). Defaults to 30s per spec §4.1. */
  timeoutMs?: number;
}

/**
 * Dependency-injectable factory deps. `llm` is the OpenAI-compatible
 * transport; the router throws at construction if it's missing — keeps
 * misconfiguration loud rather than letting it surface mid-classification.
 */
export interface ClassifierFactoryDeps {
  llm?: RemoteClassifierDeps["llm"];
  now?: () => number;
}

export interface Classifier {
  classify(input: ClassifyInput, opts?: ClassifyOptions): Promise<ClassifyResult>;
}

export function createClassifier(config: ProviderConfig, deps: ClassifierFactoryDeps): Classifier {
  if (!deps.llm) {
    throw new Error("createClassifier: provider=remote requires deps.llm");
  }
  const remoteDeps: RemoteClassifierDeps = { llm: deps.llm };
  if (deps.now !== undefined) remoteDeps.now = deps.now;
  return createRemoteClassifier(config, remoteDeps);
}
