// Markdown-backed store implementation (plan 036 Phase 2), built behind
// the `LibrarianStore` interfaces — the vault of markdown documents IS the
// storage layer.

export { parseMemoryDocument, serializeMemoryDocument } from "./memory-doc.js";
export { parseHandoffDocument, serializeHandoffDocument } from "./handoff-doc.js";
export {
  type MarkdownHandoffStoreDeps,
  createMarkdownHandoffStore,
} from "./markdown-handoff-store.js";
export {
  type MarkdownMemoryStoreDeps,
  createMarkdownMemoryStore,
} from "./markdown-memory-store.js";
