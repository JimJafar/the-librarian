// Corpus module — markdown vault I/O for the markdown rearchitecture
// (spec 035 §F1 / Phase 1). Frontmatter today; wikilink parsing and vault
// file I/O land in follow-on increments.

export {
  type CorpusDocument,
  type CorpusFrontmatter,
  CorpusFrontmatterSchema,
  parseDocument,
  serializeDocument,
} from "./frontmatter.js";
export { type Wikilink, parseWikilinks, renameWikilinkTarget } from "./wikilink.js";
export { type Vault, type VaultOptions, createVault, resolveVaultPath } from "./vault.js";
