// Disposable hybrid index (plan 036 Phase 3 / spec 035 §F2) — embed +
// keyword + wikilink graph over the markdown corpus, rebuildable from the
// source at any time. The backlink graph lands first (the "Anna problem"
// core); keyword + vector indexes follow.

export { type LinkGraph, buildLinkGraph } from "./link-graph.js";
export { type KeywordHit, type KeywordIndex, buildKeywordIndex } from "./keyword-index.js";
export {
  type VectorHit,
  type VectorIndex,
  buildVectorIndex,
  cosineSimilarity,
} from "./vector-index.js";
