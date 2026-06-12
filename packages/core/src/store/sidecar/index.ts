// Sidecar stores (plan 036 Phase 2) — file-based stores that live OUTSIDE
// the git-pushed vault: settings/secrets + curation/intake records
// (bookkeeping, not durable knowledge).

export { type JsonSettingsStoreDeps, createJsonSettingsStore } from "./settings-store.js";
export { type JsonCurationStoreDeps, createJsonCurationStore } from "./curation-store.js";
export { type JsonIntakeStoreDeps, createJsonIntakeStore } from "./intake-store.js";
