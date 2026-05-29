// Classifier-worker startup helper — store-driven boot.
//
// Post-rethink (see docs/specs/done/031-classifier-dashboard-config-spec.md
// and done/030-classifier-dashboard-config-plan.md), the LIBRARIAN_CLASSIFIER_* env
// contract is retired in favour of admin-settings persistence read from
// `readClassifierConfig(store)`. Any retired env var still set on boot
// triggers a one-line operator notice but does not affect behaviour.
//
// Worker registry: a module-scoped slot holds the started worker, its
// classifier, and the config hash it booted with (drift detection).
//
// `restartClassifierWorker` and `runClassifierSelfTest` land in T3.2 and
// T3.3 respectively; this file ships the boot-side machinery they
// compose with.

import {
  type Classifier,
  type ClassifyResult,
  type SelfTestResult,
  createClassifier,
  runSelfTest,
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
   * Test-only injection seam for the remote LLM client. Production callers
   * omit this; the boot path constructs the client from stored config via
   * `createCuratorLlmClient`. Tests pass a factory returning an in-memory
   * fake to avoid real network calls — a factory that throws models a
   * build failure (exercises the `failed` restart outcome).
   */
  _llm?: () => LlmClient;
}

interface RunningWorkerSlot {
  worker: ClassifierWorker;
  classifier: Classifier;
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
  // Reset the restart mutex too so a hung restart in one test doesn't
  // leak into the next.
  restartInFlight = null;
}

/**
 * Internal: registry getter for the restart procedure (T3.2). Exposed so
 * `restartClassifierWorker` can `worker.stop()` the prior slot before
 * booting again.
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

  // Step 3: build the classifier.
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
    configHash: classifierConfigHash(input.store),
  };
  runtimeActive = true;

  input.log?.({
    event: "classifier-worker",
    outcome: "started",
  });
  return { worker, enabled: true };
}

interface BuiltClassifier {
  classifier: Classifier;
}

/**
 * `buildClassifier` catches build-time errors and returns null after
 * logging them — appropriate for the boot path, where mcp-server keeps
 * running with no classifier on failure. The restart path needs to
 * distinguish "config not operational" from "build threw", so it calls
 * `buildClassifierOrThrow` directly and surfaces the reason.
 */
function buildClassifier(
  cfg: ClassifierConfig,
  input: BootClassifierWorkerInput,
): BuiltClassifier | null {
  try {
    return buildClassifierOrThrow(cfg, input);
  } catch (err) {
    input.log?.({
      event: "classifier-worker",
      outcome: "boot_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function buildClassifierOrThrow(
  cfg: ClassifierConfig,
  input: BootClassifierWorkerInput,
): BuiltClassifier | null {
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
  const llm: LlmClient = input._llm ? input._llm() : createCuratorLlmClient(llmConfig);
  const providerCfg: Parameters<typeof createClassifier>[0] = {
    provider: "remote",
    modelId: cfg.llm.model,
  };
  if (cfg.promptVersion !== null) providerCfg.promptVersion = cfg.promptVersion;
  const classifier = createClassifier(providerCfg, { llm });
  return { classifier };
}

// Surface unused for the production code today but kept so the
// classifier worker's `ClassifyResult` type stays referenced through
// this file (eliminates the dead-import warning if `Classifier` ever
// stops re-exporting it). Imported as a type-only alias.
type _Pinned = ClassifyResult;

// ---------- T3.2: restart machinery ----------

export type RestartOutcome =
  | "started" // No prior worker; new config operational; new worker started.
  | "stopped" // Prior worker stopped; new config not operational; registry left null.
  | "restarted" // Prior worker stopped; new config operational; new worker started.
  | "already_in_progress" // A restart was already in flight; this caller coalesced onto it.
  | "failed"; // Prior worker stopped; new config operational; new build failed.

export interface RestartResult {
  outcome: RestartOutcome;
  /** Stable digest of the running worker's config; null when no worker is running. */
  runningConfigHash: string | null;
  /** Human-readable error reason. Only set when `outcome === "failed"`. */
  reason?: string;
}

export interface RestartClassifierInput {
  store: LibrarianStore;
  appendEvent: ClassifierWorkerDeps["appendEvent"];
  log?: (entry: Record<string, unknown>) => void;
  /** Test seam — same as `BootClassifierWorkerInput._llm`. */
  _llm?: () => LlmClient;
}

// Single-flight mutex. A second `restartClassifierWorker` call coalesces
// onto the in-flight one and reports `already_in_progress`.
let restartInFlight: Promise<RestartResult> | null = null;

const DRAIN_SLOW_THRESHOLD_MS = 30_000;

/**
 * The restart procedure documented in
 * docs/specs/done/030-classifier-dashboard-config-plan.md (Shutdown ordering deep dive):
 *
 *   1. Acquire the mutex; if already-in-flight, coalesce.
 *   2. Snapshot the prior registry slot.
 *   3. Stop the prior worker (worker.stop() awaits in-flight tick).
 *      Log `drain_slow` if drain exceeds 30s; do not force-kill.
 *   4. Clear the registry.
 *   5. Read current stored config + compute target hash.
 *   6. Branch on `isOperational`: not operational → stopped.
 *   7. Build the new classifier; failure → outcome=failed,
 *      registry stays null.
 *   8. Start the new worker, stamp the registry, release the mutex.
 */
export function restartClassifierWorker(input: RestartClassifierInput): Promise<RestartResult> {
  if (restartInFlight) {
    return restartInFlight.then(
      (resolved): RestartResult => ({
        outcome: "already_in_progress",
        runningConfigHash: resolved.runningConfigHash,
      }),
    );
  }
  restartInFlight = doRestart(input);
  void restartInFlight.finally(() => {
    restartInFlight = null;
  });
  return restartInFlight;
}

async function doRestart(input: RestartClassifierInput): Promise<RestartResult> {
  const log = input.log;

  // Step 2-4: drain + clear the prior slot.
  const prior = __getRunningSlotForRestart();
  if (prior) {
    const drainStart = Date.now();
    await prior.worker.stop();
    const drainMs = Date.now() - drainStart;
    if (drainMs > DRAIN_SLOW_THRESHOLD_MS) {
      log?.({
        event: "classifier-restart",
        outcome: "drain_slow",
        drainMs,
      });
    }
  }
  __setRunningSlotForRestart(null);

  // Step 5-6: read current config.
  const cfg = readClassifierConfig(input.store);
  if (!cfg.isOperational) {
    log?.({
      event: "classifier-restart",
      outcome: "stopped",
      had_prior: prior !== null,
    });
    return { outcome: "stopped", runningConfigHash: null };
  }

  // Step 7: build the new classifier. Failure leaves the registry empty
  // and surfaces the reason to the caller.
  let built;
  try {
    built = buildClassifierOrThrow(cfg, {
      store: input.store,
      appendEvent: input.appendEvent,
      ...(input._llm !== undefined ? { _llm: input._llm } : {}),
      ...(log !== undefined ? { log } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.({
      event: "classifier-restart",
      outcome: "boot_failed",
      reason,
    });
    return { outcome: "failed", runningConfigHash: null, reason };
  }
  if (!built) {
    // `buildClassifier` returned null without throwing — most often the
    // remote token isn't set. Treat as a stop, not a failure.
    log?.({
      event: "classifier-restart",
      outcome: "stopped",
      reason: "build_returned_null",
    });
    return { outcome: "stopped", runningConfigHash: null };
  }

  // Step 8: start the new worker and stamp the registry.
  const workerDeps: ClassifierWorkerDeps = {
    db: input.store.db,
    classifier: built.classifier,
    appendEvent: input.appendEvent,
  };
  if (log) workerDeps.log = log;
  const worker = createClassifierWorker(workerDeps);
  worker.start();
  const newHash = classifierConfigHash(input.store);
  __setRunningSlotForRestart({
    worker,
    classifier: built.classifier,
    configHash: newHash,
  });
  log?.({
    event: "classifier-restart",
    outcome: prior ? "restarted" : "started",
  });
  return {
    outcome: prior ? "restarted" : "started",
    runningConfigHash: newHash,
  };
}

/**
 * Tests-only: reset the in-flight mutex between cases so a hung restart
 * in one test doesn't leak into the next.
 */
export function __resetRestartMutexForTests(): void {
  restartInFlight = null;
}

// ---------- T3.3: classifier self-test ----------

export interface ClassifierSelfTestInput {
  store: LibrarianStore;
  log?: (entry: Record<string, unknown>) => void;
  /** Test seam — same as `BootClassifierWorkerInput._llm`. */
  _llm?: () => LlmClient;
}

export type ClassifierSelfTestOutcome = "ok" | "fallback" | "error";

export interface ClassifierSelfTestResultRow {
  outcome: ClassifierSelfTestOutcome;
  /** Round-trip latency of the self-test classify call, in ms. */
  latencyMs: number;
  /** Verdict the classifier produced (ok / fallback paths). */
  verdict?: { requires_approval: boolean; is_global: boolean };
  /** Why the classifier fell back to defaults (fallback path). */
  fallbackReason?: string;
  /** Human-readable error message (error path). */
  error?: string;
  /** Raw model output, surfaced in the dashboard error panel. */
  rawOutput?: string;
}

/**
 * Build a fresh, ephemeral classifier from the current stored config,
 * run `SELF_TEST_INPUT` through it via `runSelfTest`, and return the
 * result. The running worker (if any) is untouched — the self-test
 * classifier is an independent instance.
 */
export async function runClassifierSelfTest(
  input: ClassifierSelfTestInput,
): Promise<ClassifierSelfTestResultRow> {
  const cfg = readClassifierConfig(input.store);
  if (!cfg.isOperational) {
    return {
      outcome: "error",
      latencyMs: 0,
      error: cfg.enabled
        ? "classifier config is incomplete — fill in the LLM connection"
        : "classifier is disabled",
    };
  }
  let built: BuiltClassifier;
  try {
    const maybe = buildClassifierOrThrow(cfg, {
      store: input.store,
      appendEvent: () => undefined,
      ...(input._llm !== undefined ? { _llm: input._llm } : {}),
      ...(input.log !== undefined ? { log: input.log } : {}),
    });
    if (!maybe) {
      return {
        outcome: "error",
        latencyMs: 0,
        error: "classifier build returned null (token unset?)",
      };
    }
    built = maybe;
  } catch (err) {
    return {
      outcome: "error",
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let result: SelfTestResult;
  try {
    result = await runSelfTest(built.classifier);
  } catch (err) {
    return {
      outcome: "error",
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.ok) {
    // SELF_TEST_INPUT is a benign factual snippet; the classifier
    // package's parser yields a structured verdict on the ok path.
    // We surface the parsed verdict alongside the latency when it's
    // recoverable from the raw output, omit it otherwise.
    const verdict = parseSelfTestVerdict(result.raw_output);
    return {
      outcome: "ok",
      latencyMs: result.latency_ms,
      ...(verdict !== undefined ? { verdict } : {}),
      rawOutput: result.raw_output,
    };
  }
  return {
    outcome: "fallback",
    latencyMs: result.latency_ms,
    ...(result.reason !== undefined ? { fallbackReason: result.reason } : {}),
    rawOutput: result.raw_output,
  };
}

function parseSelfTestVerdict(
  rawOutput: string,
): { requires_approval: boolean; is_global: boolean } | undefined {
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    if (typeof parsed.requires_approval !== "boolean" || typeof parsed.is_global !== "boolean") {
      return undefined;
    }
    return {
      requires_approval: parsed.requires_approval,
      is_global: parsed.is_global,
    };
  } catch {
    return undefined;
  }
}
