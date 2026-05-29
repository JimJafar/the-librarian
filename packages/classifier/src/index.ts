// @librarian/classifier — async memory classifier.
//
// Public surface: `classify()` decides the two booleans
// (`requires_approval`, `is_global`) the worker writes to a memory row.
// The provider is remote (OpenAI-compatible HTTP) — self-hosted models
// are supported by pointing the endpoint at a local server URL.

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
} from "./providers/index.js";
export { createClassifier } from "./providers/index.js";

export type { RemoteClassifierConfig, RemoteClassifierDeps } from "./providers/remote.js";
export { createRemoteClassifier } from "./providers/remote.js";

export { runSelfTest, SELF_TEST_INPUT } from "./self-test.js";
export type { SelfTestResult } from "./self-test.js";
