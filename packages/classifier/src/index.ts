// @librarian/classifier — async memory classifier.
//
// Public surface: `classify()` decides the two booleans
// (`requires_approval`, `is_global`) the worker writes to a memory row.
// Both providers (remote OpenAI-compatible + local node-llama-cpp) are
// in place; `remember`-side wiring lands in 4d.

export type {
  ClassifyInput,
  ClassifyResult,
  ClassifierVerdict,
  ClassifierFallbackReason,
} from "./types.js";
export { ClassifierVerdictSchema, CONSERVATIVE_DEFAULTS } from "./types.js";
export { parseVerdict } from "./parse.js";
export { renderPrompt, loadPromptTemplate } from "./prompt.js";

export type {
  Classifier,
  ProviderConfig,
  ClassifyOptions,
  ClassifierFactoryDeps,
  LocalInferenceClient,
} from "./providers/index.js";
export { createClassifier } from "./providers/index.js";

export type { RemoteClassifierConfig, RemoteClassifierDeps } from "./providers/remote.js";
export { createRemoteClassifier } from "./providers/remote.js";

export type { LocalClassifierConfig, LocalClassifierDeps } from "./providers/local.js";
export { createLocalClassifier } from "./providers/local.js";

export {
  createWorkerInferenceClient,
  createInferenceClientFromHandle,
} from "./providers/local-worker-host.js";
export type {
  WorkerHostConfig,
  WorkerHandle,
  LocalInferenceClientWithLifecycle,
} from "./providers/local-worker-host.js";

export type { CatalogEntry } from "./catalog.js";
export { CATALOG, DEFAULT_MODEL_ID, catalogEntry } from "./catalog.js";

export { runSelfTest, SELF_TEST_INPUT } from "./self-test.js";
export type { SelfTestResult } from "./self-test.js";
