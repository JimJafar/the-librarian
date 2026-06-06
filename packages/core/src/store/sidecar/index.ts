// Sidecar stores (plan 036 Phase 2) — file-based stores that live OUTSIDE
// the git-pushed vault: ephemeral runtime state (conv-state) and, in
// following increments, settings/secrets + curation records. They replace
// the corresponding SQLite stores at the Phase-7 cutover.

export {
  type JsonConversationStateStoreDeps,
  createJsonConversationStateStore,
} from "./conversation-state-store.js";
export { type JsonSettingsStoreDeps, createJsonSettingsStore } from "./settings-store.js";
export { type JsonCurationStoreDeps, createJsonCurationStore } from "./curation-store.js";
export {
  type JsonConsolidationStoreDeps,
  createJsonConsolidationStore,
} from "./consolidation-store.js";
