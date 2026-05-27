// Worker-thread entry for the local classifier provider. Runs in its own
// V8 isolate so node-llama-cpp's blocking inference doesn't tie up the
// mcp-server's event loop (spec §4.2). One inflight inference at a time
// — the worker dequeues only after `session.prompt()` settles, so a
// concurrent `classify` message from the host (e.g. after a host-side
// abort while the worker is still generating) is queued, not raced
// against the live `LlamaChatSession`.
//
// Message protocol (host ↔ worker):
//   Host → worker:
//     { type: "load", modelId, hfRepo?, quant? }       // configure + load
//     { type: "classify", id, prompt }                  // run inference
//     { type: "shutdown" }                              // stop
//   Worker → host:
//     { type: "ready" }                                 // model loaded
//     { type: "result", id, output }                    // inference complete
//     { type: "error", id?, kind, message }             // failure
//
// node-llama-cpp is dynamic-imported so the package installs without
// the native build (it's declared as an optionalDependency). On import
// failure we post `{type:"error", kind:"load_failed"}` and the host
// treats that as a permanent local-provider failure for this worker.
//
// This file is NOT exercised by CI's unit tests — the worker host tests
// drive the message protocol against a stub Worker. The
// `LIBRARIAN_CLASSIFIER_LOCAL_E2E=1` integration suite runs this entry
// against a real downloaded model.

import { parentPort } from "node:worker_threads";

export type WorkerInbound =
  | { type: "load"; modelId: string; hfRepo?: string; quant?: string }
  | { type: "classify"; id: number; prompt: string }
  | { type: "shutdown" };

export type WorkerOutbound =
  | { type: "ready" }
  | { type: "result"; id: number; output: string }
  | {
      type: "error";
      id?: number;
      kind: "load_failed" | "inference_failed" | "not_loaded";
      message: string;
    };

interface LlamaSession {
  prompt(text: string, opts: { temperature: number }): Promise<string>;
}

interface NodeLlamaCppShape {
  getLlama: () => Promise<{
    loadModel: (opts: { modelPath: string }) => Promise<{
      createContext: () => Promise<{
        getSequence: () => unknown;
      }>;
    }>;
  }>;
  resolveModelFile: (uriOrPath: string) => Promise<string>;
  LlamaChatSession: new (opts: { contextSequence: unknown }) => LlamaSession;
}

let session: LlamaSession | null = null;
let inflight: Promise<void> = Promise.resolve();

async function loadModel(modelId: string, hfRepo: string | undefined, quant: string | undefined) {
  // Dynamic import keeps the dependency optional. If it fails (native
  // build missing, unsupported platform), surface the error verbatim
  // via the load_failed message; the operator can act on it.
  const mod = (await import("node-llama-cpp")) as unknown as NodeLlamaCppShape;
  const uri = resolveModelUri(modelId, hfRepo, quant);
  const modelPath = await mod.resolveModelFile(uri);
  const llama = await mod.getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext();
  const sequence = context.getSequence();
  session = new mod.LlamaChatSession({ contextSequence: sequence });
}

/**
 * Map a catalog id (or admin-supplied identifier) to the URI form
 * node-llama-cpp's `resolveModelFile` expects. Filesystem paths and
 * pre-formed `hf:`/`file:`/`http(s):` URIs pass through; catalog ids
 * are looked up via the host-provided `hfRepo`.
 *
 * `quant` is reserved for future GGUF variant selection — node-llama-cpp
 * currently picks the file inside a multi-quant repo by name suffix; we
 * don't yet append it to the URI but the parameter is plumbed through
 * for when we do.
 */
function resolveModelUri(
  modelId: string,
  hfRepo: string | undefined,
  _quant: string | undefined,
): string {
  if (modelId.startsWith("/") || modelId.startsWith("file:")) return modelId;
  if (
    modelId.startsWith("hf:") ||
    modelId.startsWith("http://") ||
    modelId.startsWith("https://")
  ) {
    return modelId;
  }
  if (hfRepo) return `hf:${hfRepo}`;
  // Fall through: treat as a raw HF repo identifier (`org/name`).
  return `hf:${modelId}`;
}

async function classify(id: number, prompt: string): Promise<void> {
  if (!session) {
    post({ type: "error", id, kind: "not_loaded", message: "model not loaded" });
    return;
  }
  try {
    const output = await session.prompt(prompt, { temperature: 0 });
    post({ type: "result", id, output });
  } catch (err) {
    post({
      type: "error",
      id,
      kind: "inference_failed",
      message: err instanceof Error ? err.message : "unknown",
    });
  }
}

function post(msg: WorkerOutbound) {
  parentPort?.postMessage(msg);
}

if (parentPort) {
  parentPort.on("message", (msg: WorkerInbound) => {
    if (msg.type === "load") {
      loadModel(msg.modelId, msg.hfRepo, msg.quant)
        .then(() => post({ type: "ready" }))
        .catch((err: unknown) =>
          post({
            type: "error",
            kind: "load_failed",
            message: err instanceof Error ? err.message : "unknown",
          }),
        );
      return;
    }
    if (msg.type === "classify") {
      // Serialize on `inflight` so concurrent host messages don't race
      // against a shared `LlamaChatSession` (it's stateful and not safe
      // for concurrent calls).
      const prev = inflight;
      inflight = prev.then(() => classify(msg.id, msg.prompt));
      return;
    }
    if (msg.type === "shutdown") {
      process.exit(0);
    }
  });
}
