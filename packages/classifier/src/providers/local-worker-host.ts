// Host-side worker client — wraps the `node:worker_threads` protocol
// (see `local.worker.ts`) into the `LocalInferenceClient` interface the
// classifier provider depends on.
//
// Concurrency contract: at most one `classify` message is in flight on
// the worker at any time. The host's queue gate is released only after
// the worker has replied for that message (`result` or `error`), even
// if the caller's `infer()` promise already rejected via the abort
// signal. This matches §4.1's single-inflight constraint and prevents
// concurrent calls against the shared `LlamaChatSession`.
//
// Lifecycle:
//   - Model loads lazily on the first `infer()` call.
//   - Load failure terminates the worker so a subsequent classifier
//     reconstruction (e.g. after the operator fixes config) can start
//     clean. The current instance is poisoned — every further `infer()`
//     on it rejects with the original load error.
//   - `terminate()` (exposed via the factory return) shuts the worker
//     down; the mcp-server shutdown path uses it.

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { LocalInferenceClient } from "./local.js";
import type { WorkerInbound, WorkerOutbound } from "./local.worker.js";

export interface WorkerHostConfig {
  modelId: string;
  hfRepo?: string;
  quant?: string;
}

/**
 * Minimum the worker host needs from its underlying transport. The
 * production wiring is `node:worker_threads.Worker`; tests pass a stub
 * so the queue + protocol semantics are exercised without spawning a
 * real thread.
 */
export interface WorkerHandle {
  postMessage(msg: WorkerInbound): void;
  on(event: "message", listener: (msg: WorkerOutbound) => void): void;
  off(event: "message", listener: (msg: WorkerOutbound) => void): void;
  terminate(): Promise<unknown>;
}

export interface LocalInferenceClientWithLifecycle extends LocalInferenceClient {
  /** Shut down the underlying worker. Idempotent. */
  terminate(): Promise<void>;
}

/**
 * Build a `LocalInferenceClient` against an arbitrary `WorkerHandle`.
 * Production callers go through `createWorkerInferenceClient`; tests
 * inject a stub handle so the queue + protocol semantics are exercised
 * without spawning a real thread.
 */
export function createInferenceClientFromHandle(
  handle: WorkerHandle,
  config: WorkerHostConfig,
): LocalInferenceClientWithLifecycle {
  let loadPromise: Promise<void> | null = null;
  let workerDrain: Promise<void> = Promise.resolve();
  let nextId = 1;
  let terminated = false;

  function loadOnce(): Promise<void> {
    if (loadPromise !== null) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      const onLoadMessage = (msg: WorkerOutbound) => {
        if (msg.type === "ready") {
          handle.off("message", onLoadMessage);
          resolve();
        } else if (msg.type === "error" && msg.kind === "load_failed") {
          handle.off("message", onLoadMessage);
          // Terminate so a future client (different config) can start
          // clean; the cached rejection on THIS instance stays sticky.
          void handle.terminate().catch(() => undefined);
          terminated = true;
          reject(new Error(`model load failed: ${msg.message}`));
        }
      };
      handle.on("message", onLoadMessage);
      const cfg: WorkerInbound = { type: "load", modelId: config.modelId };
      if (config.hfRepo !== undefined) cfg.hfRepo = config.hfRepo;
      if (config.quant !== undefined) cfg.quant = config.quant;
      handle.postMessage(cfg);
    });
    return loadPromise;
  }

  return {
    async infer(prompt: string, signal: AbortSignal): Promise<string> {
      if (terminated) throw new Error("worker terminated");

      // Two-stage gating: `prevDrain` blocks our post until the worker
      // is idle; we publish `workerDrain` immediately so the next
      // caller awaits *our* worker-side completion — even if our host
      // promise settled early via the abort signal.
      const prevDrain = workerDrain;
      let releaseDrain: () => void = () => undefined;
      let drainReleased = false;
      const releaseOnce = () => {
        if (!drainReleased) {
          drainReleased = true;
          releaseDrain();
        }
      };
      workerDrain = new Promise<void>((r) => (releaseDrain = r));
      let posted = false;

      try {
        await prevDrain;
        await loadOnce();
        if (signal.aborted) throw new Error("aborted");

        const id = nextId++;
        posted = true;
        return await new Promise<string>((resolve, reject) => {
          const onMessage = (msg: WorkerOutbound) => {
            if (msg.type === "result" && msg.id === id) {
              cleanup();
              releaseOnce();
              resolve(msg.output);
            } else if (msg.type === "error" && msg.id === id) {
              cleanup();
              releaseOnce();
              reject(new Error(`${msg.kind}: ${msg.message}`));
            }
          };
          const onLateReply = (msg: WorkerOutbound) => {
            if (
              (msg.type === "result" && msg.id === id) ||
              (msg.type === "error" && msg.id === id)
            ) {
              handle.off("message", onLateReply);
              releaseOnce();
            }
          };
          const onAbort = () => {
            // Swap the normal handler for a drain-only listener — the
            // worker is still generating; we just don't want its reply.
            handle.off("message", onMessage);
            signal.removeEventListener("abort", onAbort);
            handle.on("message", onLateReply);
            reject(new Error("aborted"));
          };
          function cleanup() {
            handle.off("message", onMessage);
            signal.removeEventListener("abort", onAbort);
          }
          handle.on("message", onMessage);
          signal.addEventListener("abort", onAbort, { once: true });
          handle.postMessage({ type: "classify", id, prompt });
        });
      } catch (err) {
        // Pre-post failures (prevDrain reject, loadOnce reject, sync
        // abort) leave the worker idle; release our gate immediately.
        // Post-post failures already arranged for release via the late-
        // reply listener or the normal onMessage path.
        if (!posted) releaseOnce();
        throw err;
      }
    },
    async terminate(): Promise<void> {
      if (terminated) return;
      terminated = true;
      await handle.terminate().catch(() => undefined);
    },
  };
}

/**
 * Build a `LocalInferenceClient` backed by a `node-llama-cpp` worker
 * thread. The worker script lives at `dist/providers/local.worker.js`
 * once the package is built — production callers should ensure they
 * run against the built output, not the source tree.
 */
export function createWorkerInferenceClient(
  config: WorkerHostConfig,
): LocalInferenceClientWithLifecycle {
  const workerUrl = new URL("./local.worker.js", import.meta.url);
  const worker = new Worker(fileURLToPath(workerUrl));
  const handle: WorkerHandle = {
    postMessage: (msg) => worker.postMessage(msg),
    on: (_event, listener) => worker.on("message", listener),
    off: (_event, listener) => worker.off("message", listener),
    terminate: () => worker.terminate(),
  };
  return createInferenceClientFromHandle(handle, config);
}
