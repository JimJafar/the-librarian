// Provider router — dispatches classify() to the configured provider.
//
// Two providers ship in V1: `remote` (OpenAI-compatible HTTP, spec §4.2)
// and `local` (GGUF via node-llama-cpp on a worker thread, §4.3). The
// router stays test-friendly by accepting an injectable
// `LocalInferenceClient` factory — production wires it to the
// worker-backed client; tests pass an in-memory fake.

import type { ClassifyInput, ClassifyResult } from "../types.js";
import {
  createLocalClassifier,
  type LocalClassifierConfig,
  type LocalClassifierDeps,
  type LocalInferenceClient,
} from "./local.js";
import {
  createRemoteClassifier,
  type RemoteClassifierConfig,
  type RemoteClassifierDeps,
} from "./remote.js";

/**
 * Provider config discriminated union. Local config carries the model
 * id + optional quant; remote carries the model id + optional prompt
 * version (transport details flow through `RemoteClassifierDeps`).
 */
export type ProviderConfig =
  | (RemoteClassifierConfig & { provider: "remote" })
  | { provider: "local"; modelId: string; quant?: string; promptVersion?: string };

export interface ClassifyOptions {
  /** Per-attempt timeout (ms). Defaults to 30s per spec §4.1. */
  timeoutMs?: number;
}

/**
 * Dependency-injectable factory deps. Pass `llm` to enable `remote`,
 * `inferenceFor` to enable `local`. The router throws at construction
 * if the requested provider's dep is missing — keeps misconfiguration
 * loud rather than letting it surface mid-classification.
 */
export interface ClassifierFactoryDeps {
  llm?: RemoteClassifierDeps["llm"];
  now?: () => number;
  inferenceFor?: (config: { modelId: string; quant?: string }) => LocalInferenceClient;
}

export interface Classifier {
  classify(input: ClassifyInput, opts?: ClassifyOptions): Promise<ClassifyResult>;
}

export function createClassifier(config: ProviderConfig, deps: ClassifierFactoryDeps): Classifier {
  if (config.provider === "remote") {
    if (!deps.llm) {
      throw new Error("createClassifier: provider=remote requires deps.llm");
    }
    const remoteDeps: RemoteClassifierDeps = { llm: deps.llm };
    if (deps.now !== undefined) remoteDeps.now = deps.now;
    return createRemoteClassifier(config, remoteDeps);
  }
  if (!deps.inferenceFor) {
    throw new Error(
      "createClassifier: provider=local requires deps.inferenceFor — wire " +
        "createWorkerInferenceClient or inject a fake.",
    );
  }
  const inferenceCfg: { modelId: string; quant?: string } = { modelId: config.modelId };
  if (config.quant !== undefined) inferenceCfg.quant = config.quant;
  const inference = deps.inferenceFor(inferenceCfg);

  const localConfig: LocalClassifierConfig = { modelId: config.modelId };
  if (config.quant !== undefined) localConfig.quant = config.quant;
  if (config.promptVersion !== undefined) localConfig.promptVersion = config.promptVersion;
  const localDeps: LocalClassifierDeps = { inference };
  if (deps.now !== undefined) localDeps.now = deps.now;
  return createLocalClassifier(localConfig, localDeps);
}

export type { LocalInferenceClient } from "./local.js";
