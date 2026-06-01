// Disposable hybrid index (plan 036 Phase 3 / spec 035 §F2) — embed +
// keyword + wikilink graph over the markdown corpus, rebuildable from the
// source at any time. The backlink graph lands first (the "Anna problem"
// core); keyword + vector indexes follow.

export { type LinkGraph, buildLinkGraph } from "./link-graph.js";
