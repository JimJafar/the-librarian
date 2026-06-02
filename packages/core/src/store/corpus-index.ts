// Vault → index bridge (plan 036 Phase 3/7 cutover / spec 035 §F2-F4). Reads the
// markdown vault and builds the namespaced hybrid index that recall +
// search_references run over:
//   - memories/<id>.md   → Tier-1 corpus (active only; archived are excluded)
//   - references/**.md    → Tier-0 references (raw markdown, retrieved on demand)
//
// This is the disposable index — rebuildable from the vault at any time (the
// reindex / "delete .index/ → rebuild → equivalent hits" contract is just
// calling this again). Corpus ids are memory ids (resolve via the store);
// reference ids are vault-relative paths (resolve via vault.readText).
//
// Built against the current memory-doc schema: title + body + tags compose the
// searchable text (like searchMemories; project_key is omitted — this is a
// different retrieval engine). The D16 frontmatter minimisation is a separable
// later cleanup and does not gate this.

import { MemoryStatus } from "./../schemas/common.js";
import type { Vault } from "./corpus/vault.js";
import {
  type Embedder,
  type IndexNamespace,
  type NamespacedDoc,
  type NamespacedIndex,
  type ReferenceHit,
  createNamespacedIndex,
} from "./index/index.js";
import { parseMemoryDocument } from "./markdown/memory-doc.js";
import type { Memory } from "./memory-store.js";

const CORPUS_DIR = "memories";
const REFERENCES_DIR = "references";

export interface CorpusIndexOptions {
  embedder: Embedder;
}

/** memories/ → corpus, references/ → references, anything else → excluded. */
function classifyNamespace(relPath: string): IndexNamespace | null {
  if (relPath.startsWith(`${REFERENCES_DIR}/`)) return "references";
  if (relPath.startsWith(`${CORPUS_DIR}/`)) return "corpus";
  return null; // handoffs/, skills/, archive/, etc. are not Tier-1 recall material
}

export async function buildCorpusIndex(
  vault: Vault,
  options: CorpusIndexOptions,
): Promise<NamespacedIndex> {
  const docs: NamespacedDoc[] = [];

  for (const relPath of vault.listMarkdown()) {
    const namespace = classifyNamespace(relPath);
    if (namespace === null) continue;

    if (namespace === "references") {
      // raw markdown; id is the vault-relative path so the caller can fetch it
      docs.push({ id: relPath, text: vault.readText(relPath), namespace });
      continue;
    }

    // Fail-soft: a hand-edited / foreign .md under memories/ that doesn't parse
    // as a memory is skipped, so one bad file can't take down all recall. (The
    // vault is git-pushed + hand-editable; surfacing corrupt files is a
    // dashboard/health concern, not a reason to fail the whole index build.)
    let memory;
    try {
      memory = parseMemoryDocument(vault.readText(relPath));
    } catch {
      continue;
    }
    // Active only — matches searchMemories' recall filter; proposals (pending
    // approval) and archived memories must not surface in recall.
    if (memory.status !== MemoryStatus.Active) continue;
    docs.push({
      id: memory.id,
      text: `${memory.title} ${memory.body} ${memory.tags.join(" ")}`,
      namespace,
    });
  }

  return createNamespacedIndex(docs, options.embedder);
}

const MAX_REFERENCE_LIMIT = 100;

/** Bound the caller-supplied limit at the store level; invalid → the index default. */
function clampReferenceLimit(limit?: number): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return undefined;
  return Math.min(Math.floor(limit), MAX_REFERENCE_LIMIT);
}

/**
 * Tier-0 lookup: search the vault's `references/` only (no corpus embedding).
 * Builds a references-only index per call — references are few and
 * search_references is infrequent, so this stays simple (no cache). Returns the
 * matched reference's pointer (vault-relative path) + relevant section.
 *
 * The per-call rebuild is bounded by the reference-set size; revisit with a
 * cache if references/ ever grows large (especially under the real embedder).
 */
export async function searchReferences(
  vault: Vault,
  embedder: Embedder,
  query: string,
  limit?: number,
): Promise<ReferenceHit[]> {
  const relPaths = vault.listMarkdown(REFERENCES_DIR);
  // No references → nothing to search; return early so we never load/download a
  // model just to embed the query against an empty index.
  if (relPaths.length === 0) return [];
  const docs: NamespacedDoc[] = relPaths.map((relPath) => ({
    id: relPath,
    text: vault.readText(relPath),
    namespace: "references",
  }));
  const index = await createNamespacedIndex(docs, embedder);
  return index.searchReferences(query, clampReferenceLimit(limit));
}

export interface RecallMemoriesDeps {
  /** A built (and ideally cached) corpus index — see buildCorpusIndex. */
  index: NamespacedIndex;
  getMemory: (id: string) => Memory | null;
}

export interface RecallMemoriesOptions {
  /** Project scope; like searchMemories, globals (project_key null) always match. */
  projectKey?: string | undefined;
  /** Any-match tag filter. */
  tags?: string[] | undefined;
  limit?: number | undefined;
}

/**
 * Index-backed memory recall: rank active corpus memories by the (caller-
 * supplied, cacheable) hybrid index, then apply the same filters searchMemories
 * does (project_key incl. globals, tags any-match) and bound to `limit`.
 * Over-fetches from the index so the post-filter still fills the limit. The
 * no-query / filter-only path stays on searchMemories (caller's concern).
 *
 * Recall-quality note: the candidate pool is bounded (over-fetch + the index's
 * internal seed cap), so a very selective filter (e.g. a rare tag held only by
 * deep-ranked memories) can return fewer than `limit` even when more matches
 * exist. Acceptable for typical limits; revisit if it bites.
 */
export async function recallMemories(
  deps: RecallMemoriesDeps,
  query: string,
  options: RecallMemoriesOptions = {},
): Promise<Memory[]> {
  const limit = options.limit ?? 8;
  const hits = await deps.index.recall(query, { limit: Math.max(limit * 4, 24) });
  const projectKey = options.projectKey ?? "";
  const tagSet = new Set(options.tags ?? []);
  const out: Memory[] = [];
  for (const hit of hits) {
    const memory = deps.getMemory(hit.id);
    if (!memory) continue; // stale id (vault changed mid-flight) — skip
    if (projectKey && !(memory.project_key == null || memory.project_key === projectKey)) continue;
    if (tagSet.size && !(memory.tags ?? []).some((tag) => tagSet.has(tag))) continue;
    out.push(memory);
    if (out.length >= limit) break;
  }
  return out;
}
