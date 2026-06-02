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
// Built against the current memory-doc schema (title + body + tags compose the
// searchable text, matching searchMemories); the D16 frontmatter minimisation
// is a separable later cleanup and does not gate this.

import type { Vault } from "./corpus/vault.js";
import {
  type Embedder,
  type IndexNamespace,
  type NamespacedDoc,
  type NamespacedIndex,
  createNamespacedIndex,
} from "./index/index.js";
import { parseMemoryDocument } from "./markdown/memory-doc.js";

const CORPUS_DIR = "memories";
const REFERENCES_DIR = "references";
const ARCHIVED_STATUS = "archived";

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

    const memory = parseMemoryDocument(vault.readText(relPath));
    if (memory.status === ARCHIVED_STATUS) continue; // archived ⇒ out of recall
    docs.push({
      id: memory.id,
      text: `${memory.title} ${memory.body} ${memory.tags.join(" ")}`,
      namespace,
    });
  }

  return createNamespacedIndex(docs, options.embedder);
}
