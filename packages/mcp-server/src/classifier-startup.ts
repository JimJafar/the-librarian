// Classifier-worker startup helper — builds and starts the classifier
// worker from environment configuration (spec §4.2 + plan Section 4d).
//
// Env contract (admin-settings persistence is a 4d.2 follow-up):
//   LIBRARIAN_CLASSIFIER_ENABLED         "true" to opt-in. Anything else
//                                        leaves the worker off; mcp-server
//                                        boots with no classifier and
//                                        `remember` continues through the
//                                        legacy bridge.
//   LIBRARIAN_CLASSIFIER_PROVIDER        "remote" (default) | "local"
//   LIBRARIAN_CLASSIFIER_REMOTE_ENDPOINT OpenAI-compatible base URL
//   LIBRARIAN_CLASSIFIER_REMOTE_TOKEN    bearer token
//   LIBRARIAN_CLASSIFIER_REMOTE_MODEL    e.g. "gpt-4o-mini"
//   LIBRARIAN_CLASSIFIER_LOCAL_MODEL     catalog id or HF identifier
//   LIBRARIAN_CLASSIFIER_LOCAL_QUANT     optional, e.g. "Q4_K_M"
//
// `boot()` returns either a started worker (with `stop` for shutdown) or
// `null` when the env says off / is incomplete. Misconfiguration logs and
// returns null; mcp-server keeps running without the classifier.

import {
  createClassifier,
  createWorkerInferenceClient,
  type Classifier,
  type ProviderConfig,
} from "@librarian/classifier";
import { createCuratorLlmClient, type LlmClientConfig } from "@librarian/core";
import {
  createClassifierWorker,
  type ClassifierWorker,
  type ClassifierWorkerDeps,
} from "./classifier-worker.js";

export interface BootClassifierWorkerInput {
  /** SQLite handle (the projection's connection). */
  db: ClassifierWorkerDeps["db"];
  /** Event appender — the wider store's `appendEvent`. */
  appendEvent: ClassifierWorkerDeps["appendEvent"];
  /** Optional sidecar logger. */
  log?: (entry: Record<string, unknown>) => void;
  /** Env source — defaults to `process.env`. Tests inject. */
  env?: NodeJS.ProcessEnv;
}

export interface BootedClassifierWorker {
  worker: ClassifierWorker;
  /** Tells the boot caller whether the worker actively classifies new writes. */
  enabled: true;
}

/**
 * Module-scoped flag the MCP tool layer reads at handler time so
 * `remember` knows whether the classifier worker is active and writes
 * should land at conservative defaults. Set by `bootClassifierWorker`
 * on successful boot; never read outside this module after that.
 */
let runtimeActive = false;

/** Read by `mcp/tools/remember.ts` to decide the write-path policy. */
export function isClassifierRuntimeActive(): boolean {
  return runtimeActive;
}

/**
 * Tests-only: reset the runtime flag between cases so tests don't
 * leak state across `bootClassifierWorker()` calls. Not part of the
 * production API.
 */
export function __resetClassifierRuntimeForTests(): void {
  runtimeActive = false;
}

export function bootClassifierWorker(
  input: BootClassifierWorkerInput,
): BootedClassifierWorker | null {
  const env = input.env ?? process.env;
  if (env.LIBRARIAN_CLASSIFIER_ENABLED !== "true") return null;

  const provider = (env.LIBRARIAN_CLASSIFIER_PROVIDER ?? "remote") as "remote" | "local";
  const classifier = tryBuildClassifier(env, provider, input.log);
  if (!classifier) return null;

  const workerDeps: ClassifierWorkerDeps = {
    db: input.db,
    classifier,
    appendEvent: input.appendEvent,
  };
  if (input.log) workerDeps.log = input.log;
  const worker = createClassifierWorker(workerDeps);
  worker.start();
  runtimeActive = true;
  input.log?.({
    event: "classifier-worker",
    outcome: "started",
    provider,
  });
  return { worker, enabled: true };
}

function tryBuildClassifier(
  env: NodeJS.ProcessEnv,
  provider: "remote" | "local",
  log?: (entry: Record<string, unknown>) => void,
): Classifier | null {
  try {
    if (provider === "remote") {
      const endpoint = env.LIBRARIAN_CLASSIFIER_REMOTE_ENDPOINT;
      const token = env.LIBRARIAN_CLASSIFIER_REMOTE_TOKEN;
      const model = env.LIBRARIAN_CLASSIFIER_REMOTE_MODEL;
      if (!endpoint || !token || !model) {
        log?.({
          event: "classifier-worker",
          outcome: "boot_skipped",
          reason: "remote_env_incomplete",
        });
        return null;
      }
      const llmConfig: LlmClientConfig = { endpoint, token, model };
      const llm = createCuratorLlmClient(llmConfig);
      const cfg: ProviderConfig = { provider: "remote", modelId: model };
      return createClassifier(cfg, { llm });
    }
    const modelId = env.LIBRARIAN_CLASSIFIER_LOCAL_MODEL;
    if (!modelId) {
      log?.({
        event: "classifier-worker",
        outcome: "boot_skipped",
        reason: "local_model_unset",
      });
      return null;
    }
    const localCfg: ProviderConfig = { provider: "local", modelId };
    const quant = env.LIBRARIAN_CLASSIFIER_LOCAL_QUANT;
    if (quant !== undefined) localCfg.quant = quant;
    return createClassifier(localCfg, {
      inferenceFor: (cfg) => createWorkerInferenceClient(cfg),
    });
  } catch (err) {
    log?.({
      event: "classifier-worker",
      outcome: "boot_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
