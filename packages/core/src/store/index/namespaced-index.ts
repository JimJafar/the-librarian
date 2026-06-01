// Namespaced disposable index (plan 036 Phase 3 / spec 035 §F2, F4). Corpus
// (Tier 1) and references (Tier 0) are indexed SEPARATELY: `recall` runs over
// the corpus index + link graph (backlink-aware, the self-contained bundle),
// `searchReferences` runs over the references index only. Keeping them in
// distinct indexes makes Tier-0/Tier-1 isolation structural — a reference doc
// can never leak into recall (S8) and is never backlink-expanded — rather than
// a filter that could be forgotten.
//
// References are deliberately hybrid-only (no link graph): they are background
// material, not consolidated or session-injected, retrieved only on demand.
//
// Ids are assumed globally unique across both namespaces (the file/slug layer
// guarantees this); a Tier-1 and a Tier-0 doc must not share an id.

import { type Embedder, buildHybridIndex } from "./hybrid-index.js";
import { buildLinkGraph } from "./link-graph.js";
import { type RecallOptions, type RecalledDoc, recallFromIndex } from "./recall.js";

export type IndexNamespace = "corpus" | "references";

export interface NamespacedDoc {
  id: string;
  text: string;
  namespace: IndexNamespace;
}

/** A Tier-0 reference hit: a pointer (id) + relevance score. */
export interface ReferenceHit {
  id: string;
  score: number;
}

export interface NamespacedIndex {
  /** Tier-1 backlink-aware recall over the corpus namespace only. */
  recall(query: string, options?: RecallOptions): Promise<RecalledDoc[]>;
  /** Tier-0 lookup over the references namespace only (pointer + score). */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
}

const DEFAULT_REFERENCE_LIMIT = 12;

export async function createNamespacedIndex(
  docs: NamespacedDoc[],
  embedder: Embedder,
): Promise<NamespacedIndex> {
  const corpusDocs = docs.filter((doc) => doc.namespace === "corpus");
  const referenceDocs = docs.filter((doc) => doc.namespace === "references");

  const corpusHybrid = await buildHybridIndex(
    corpusDocs.map((doc) => ({ id: doc.id, text: doc.text })),
    embedder,
  );
  // restrictToKnownIds: a corpus doc that links to a reference (or a dangling
  // target) must not pull that out-of-namespace doc into Tier-1 recall (S8).
  const corpusGraph = buildLinkGraph(
    corpusDocs.map((doc) => ({ id: doc.id, body: doc.text })),
    { restrictToKnownIds: true },
  );
  const referenceHybrid = await buildHybridIndex(
    referenceDocs.map((doc) => ({ id: doc.id, text: doc.text })),
    embedder,
  );

  return {
    recall(query, options) {
      return recallFromIndex({ hybrid: corpusHybrid, linkGraph: corpusGraph }, query, options);
    },
    async searchReferences(query, limit) {
      const hits = await referenceHybrid.search(query, limit ?? DEFAULT_REFERENCE_LIMIT);
      return hits.map((hit) => ({ id: hit.id, score: hit.score }));
    },
  };
}
