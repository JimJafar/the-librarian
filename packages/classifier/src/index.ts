// @librarian/classifier — async memory classifier.
//
// Public surface: `classify()` decides the two booleans
// (`requires_approval`, `is_global`) the worker writes to a memory row.
// In Section 4a the only working provider is `remote`; `local` lands
// in 4b and `remember`-side wiring lands in 4d.

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
