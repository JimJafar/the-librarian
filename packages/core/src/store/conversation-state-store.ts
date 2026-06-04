// Conversation-state store — the SQLite implementation was removed (markdown
// backend only, spec 040). The type contract lives in
// `conversation-state-types.ts`; re-exported from this old path so importers don't
// change. The markdown backend uses the sidecar `createJsonConversationStateStore`.
export type { ConversationStateStore } from "./conversation-state-types.js";
