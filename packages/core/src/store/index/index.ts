// Disposable hybrid index (plan 036 Phase 3 / spec 035 §F2) — embed +
// keyword + wikilink graph over the markdown corpus, rebuildable from the
// source at any time. The backlink graph lands first (the "Anna problem"
// core); keyword + vector indexes follow.

export { type LinkGraph, type LinkGraphOptions, buildLinkGraph } from "./link-graph.js";
export { type KeywordHit, type KeywordIndex, buildKeywordIndex } from "./keyword-index.js";
export {
  type VectorHit,
  type VectorIndex,
  buildVectorIndex,
  cosineSimilarity,
} from "./vector-index.js";
export {
  type Embedder,
  type HybridHit,
  type HybridIndex,
  buildHybridIndex,
  createHashEmbedder,
} from "./hybrid-index.js";
export { type LlamaEmbedderOptions, createLlamaEmbedder } from "./llama-embedder.js";
export {
  type RecallDeps,
  type RecallOptions,
  type RecalledDoc,
  recallFromIndex,
} from "./recall.js";
export {
  type IndexNamespace,
  type NamespacedDoc,
  type NamespacedIndex,
  type ReferenceHit,
  createNamespacedIndex,
} from "./namespaced-index.js";
export { extractRelevantSection } from "./reference-section.js";
