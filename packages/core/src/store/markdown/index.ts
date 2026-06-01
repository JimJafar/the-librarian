// Markdown-backed store implementation (plan 036 Phase 2). Built behind
// the existing `LibrarianStore` interfaces, parity-first; replaces the
// SQLite `memory-store.ts` at the Phase-7 cutover.

export { parseMemoryDocument, serializeMemoryDocument } from "./memory-doc.js";
