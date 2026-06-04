// Conversation-state store — shared type contract (memory-domain-isolation §4.8).
//
// The backend-agnostic `ConversationStateStore` surface: the per-conversation
// runtime registry keyed by `conv_id`. The concrete SQLite implementation lives
// in `conversation-state-store.ts` and re-exports this for back-compat.

import type { ConversationState, ConversationStatePatch } from "../schemas/conversation-state.js";

export interface ConversationStateStore {
  get(convId: string): ConversationState | null;
  upsert(convId: string, patch: ConversationStatePatch): ConversationState;
  clear(convId: string): void;
}
