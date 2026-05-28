// Classifier-worker startup helper — store-driven boot.
//
// Post-rethink (see docs/specs/classifier-dashboard-config-spec.md and
// classifier-dashboard-config-plan.md), the LIBRARIAN_CLASSIFIER_* env
// contract is retired in favour of admin-settings persistence read from
// `readClassifierConfig(store)`. Any retired env var still set on boot
// triggers a one-line operator notice but does not affect behaviour.
//
// Worker registry: a module-scoped slot holds the started worker, its
// classifier, and (for local provider) the lifecycle handle needed to
// terminate the Node Worker thread on restart. The lifecycle is captured
// here, BEFORE the `createClassifier` factory is called, because the
// factory consumes the handle and doesn't expose it to its caller — so
// keeping a reference externally is the only way the restart procedure
// can clean up the Node Worker.
//
// `restartClassifierWorker` and `runClassifierSelfTest` land in T3.2 and
// T3.3 respectively; this file ships the boot-side machinery they
// compose with.

import {
  type Classifier,
  type ClassifyResult,
  type LocalInferenceClient,
  createClassifier,
  createWorkerInferenceClient,
} from "@librarian/classifier";
import {
  type ClassifierConfig,
  type LibrarianStore,
  type LlmClient,
  classifierConfigHash,
  createCuratorLlmClient,
  findLegacyClassifierEnvKeys,
  readClassifierConfig,
  resolveClassifierToken,
} from "@librarian/core";
import {
  createClassifierWorker,
  type ClassifierWorker,
  type ClassifierWorkerDeps,
} from "./classifier-worker.js";

export interface BootClassifierWorkerInput {
  /**
   * Store handle — the boot path reads classifier config + resolves the
   * encrypted token via the same connection the worker will use.
   */
  store: LibrarianStore;
  /** Event appender — the wider store's `appendEvent`. */
  appendEvent: ClassifierWorkerDeps["appendEvent"];
  /** Optional sidecar logger. */
  log?: (entry: Record<string, unknown>) => void;
  /**
   * Env source — defaults to `process.env`. Boot reads it only to detect
   * retired `LIBRARIAN_CLASSIFIER_*` keys and emit a notice. Configuration
   * itself comes from the store.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test-only injection seam for the local provider's inference factory.
   * Production callers omit this; the boot path calls
   * `createWorkerInferenceClient` directly.
   */
  _inferenceFor?: (cfg: { modelId: string; quant?: string }) => LocalInferenceClient;
}

interface RunningWorkerSlot {
  worker: ClassifierWorker;
  classifier: Classifier;
  /** Idempotent terminate for the local Node Worker thread; no-op for remote. */
  lifecycle: { terminate: () => Promise<void> };
  /** Stable digest of the config the worker booted with (drift detection). */
  configHash: string;
}

export interface BootedClassifierWorker {
  worker: ClassifierWorker;
  /** Tells the boot caller whether the worker actively classifies new writes. */
  enabled: true;
}

export interface RunningWorkerState {
  /**
   * Whether a worker is currently running. `false` even when the store
   * config says `enabled=true` if the boot path returned null
   * (incomplete config, build failure).
   */
  enabled: boolean;
  /** Stable digest of the config the running worker booted with; null when not running. */
  runningConfigHash: string | null;
}

// Module-scoped registry. The wider mcp-server process treats this as
// the single source of truth for "is the classifier running, and with
// what config".
let currentlyRunning: RunningWorkerSlot | null = null;
let runtimeActive = false;

/** Read by `mcp/tools/remember.ts` to decide the write-path policy. */
export function isClassifierRuntimeActive(): boolean {
  return runtimeActive;
}

/**
 * Snapshot of the running worker's state for the dashboard's drift
 * banner. The hash is compared against `classifierConfigHash(store)` on
 * each `workerState` query; mismatch → drift → operator restarts.
 */
export function getRunningWorkerState(): RunningWorkerState {
  return {
    enabled: runtimeActive,
    runningConfigHash: currentlyRunning?.configHash ?? null,
  };
}

/**
 * Tests-only: reset the registry between cases so tests don't leak state
 * across `bootClassifierWorker()` calls. Not part of the production API.
 */
export function __resetClassifierRuntimeForTests(): void {
  currentlyRunning = null;
  runtimeActive = false;
}

/**
 * Internal: registry getter for the restart procedure (T3.2). Exposed so
 * `restartClassifierWorker` can `worker.stop()` + `lifecycle.terminate()`
 * the prior slot before booting again.
 */
export function __getRunningSlotForRestart(): RunningWorkerSlot | null {
  return currentlyRunning;
}

/**
 * Internal: registry setter for the restart procedure. Returns the prior
 * slot so the caller can compare or fall back.
 */
export function __setRunningSlotForRestart(
  next: RunningWorkerSlot | null,
): RunningWorkerSlot | null {
  const prior = currentlyRunning;
  currentlyRunning = next;
  runtimeActive = next !== null;
  return prior;
}

export function bootClassifierWorker(
  input: BootClassifierWorkerInput,
): BootedClassifierWorker | null {
  const env = input.env ?? process.env;

  // Step 1: env-retirement notice. Emits once per boot when any retired
  // key is set, regardless of store state. Does not affect behaviour.
  const legacyKeys = findLegacyClassifierEnvKeys(env);
  if (legacyKeys.length > 0 && input.log) {
    input.log({
      event: "classifier_env_retired",
      level: "warn",
      keys: legacyKeys,
      hint: "Classifier env vars are retired; configure via the /classifier dashboard cockpit.",
    });
  }

  // Step 2: read the stored config. Disabled or incomplete → no worker.
  const cfg = readClassifierConfig(input.store);
  if (!cfg.isOperational) {
    return null;
  }

  // Step 3: build the classifier (provider-mode branch).
  const built = buildClassifier(cfg, input);
  if (!built) {
    return null;
  }

  // Step 4: start the worker and stamp the registry.
  const workerDeps: ClassifierWorkerDeps = {
    db: input.store.db,
    classifier: built.classifier,
    appendEvent: input.appendEvent,
  };
  if (input.log) workerDeps.log = input.log;
  const worker = createClassifierWorker(workerDeps);
  worker.start();

  currentlyRunning = {
    worker,
    classifier: built.classifier,
    lifecycle: built.lifecycle,
    configHash: classifierConfigHash(input.store),
  };
  runtimeActive = true;

  input.log?.({
    event: "classifier-worker",
    outcome: "started",
    provider: cfg.providerMode,
  });
  return { worker, enabled: true };
}

interface BuiltClassifier {
  classifier: Classifier;
  /** Idempotent. No-op for remote provider; terminates the Node Worker thread for local. */
  lifecycle: { terminate: () => Promise<void> };
}

function buildClassifier(
  cfg: ClassifierConfig,
  input: BootClassifierWorkerInput,
): BuiltClassifier | null {
  try {
    if (cfg.providerMode === "remote") {
      // resolveClassifierToken decrypts the bearer; requires the master key.
      const token = resolveClassifierToken(input.store);
      if (!token) {
        input.log?.({
          event: "classifier-worker",
          outcome: "boot_skipped",
          reason: "remote_token_unset",
        });
        return null;
      }
      const llmConfig: Parameters<typeof createCuratorLlmClient>[0] = {
        endpoint: cfg.llm.endpoint,
        token,
        model: cfg.llm.model,
        timeoutMs: cfg.llm.timeoutMs,
      };
      const llm: LlmClient = createCuratorLlmClient(llmConfig);
      const providerCfg: Parameters<typeof createClassifier>[0] = {
        provider: "remote",
        modelId: cfg.llm.model,
      };
      if (cfg.promptVersion !== null) providerCfg.promptVersion = cfg.promptVersion;
      const classifier = createClassifier(providerCfg, { llm });
      return { classifier, lifecycle: noopLifecycle() };
    }

    // local provider: capture the lifecycle handle BEFORE handing the
    // bare client to createClassifier (the factory consumes it and
    // doesn't expose the lifecycle externally).
    const inferenceFor =
      input._inferenceFor ??
      ((c: { modelId: string; quant?: string }) => createWorkerInferenceClient(c));
    const inferenceCfg: { modelId: string; quant?: string } = { modelId: cfg.local.modelId };
    if (cfg.local.quant !== null) inferenceCfg.quant = cfg.local.quant;
    const inferenceClient = inferenceFor(inferenceCfg);
    const providerCfg: Parameters<typeof createClassifier>[0] = {
      provider: "local",
      modelId: cfg.local.modelId,
    };
    if (cfg.local.quant !== null) providerCfg.quant = cfg.local.quant;
    if (cfg.promptVersion !== null) providerCfg.promptVersion = cfg.promptVersion;
    const classifier = createClassifier(providerCfg, {
      inferenceFor: () => inferenceClient,
    });
    return { classifier, lifecycle: extractLifecycle(inferenceClient) };
  } catch (err) {
    input.log?.({
      event: "classifier-worker",
      outcome: "boot_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function noopLifecycle(): { terminate: () => Promise<void> } {
  return { terminate: async () => undefined };
}

/**
 * The production `createWorkerInferenceClient` returns a
 * `LocalInferenceClientWithLifecycle` (extends `LocalInferenceClient`
 * with `terminate`/`alive`). Tests inject a plain `LocalInferenceClient`
 * with no lifecycle — extract the terminator defensively.
 */
function extractLifecycle(client: LocalInferenceClient): { terminate: () => Promise<void> } {
  const maybeWithLifecycle = client as LocalInferenceClient & {
    terminate?: () => Promise<void> | void;
  };
  if (typeof maybeWithLifecycle.terminate !== "function") {
    return noopLifecycle();
  }
  const terminate = maybeWithLifecycle.terminate;
  return {
    terminate: async () => {
      await terminate.call(maybeWithLifecycle);
    },
  };
}

// Surface unused for the production code today but kept so the
// classifier worker's `ClassifyResult` type stays referenced through
// this file (eliminates the dead-import warning if `Classifier` ever
// stops re-exporting it). Imported as a type-only alias.
type _Pinned = ClassifyResult;
