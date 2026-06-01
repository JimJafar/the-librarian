// Hook-injection helper — renders the per-turn `<conversation-state>`
// system reminder from memory-domain-isolation §4.9.
//
// Lives in @librarian/core so every harness integration — Claude Code's
// UserPromptSubmit hook, Hermes's equivalent, the CLI wrapper — produces
// identical bytes from the same registry state. The exact wire shape is
// part of the spec contract: changing the rendered format means changing
// what every harness reinjects on every turn.

import type { ConversationState } from "./schemas/conversation-state.js";

/**
 * Render the per-turn conv-state block that hook code injects ahead of
 * each user message. Returns the empty string when there is no state
 * yet — first-turn behaviour falls through to the signal-precedence
 * chain (§4.10), which is harness-side and out of scope for this helper.
 *
 * Shape pinned by spec §4.9 (D16 dropped the `domain` line):
 *
 *   <conversation-state>
 *     conv_id: <id>
 *     session_id: <id or none>
 *     off_record: <true|false>
 *   </conversation-state>
 */
export function renderConvStateBlock(state: ConversationState | null): string {
  if (!state) return "";
  const sessionId = state.session_id ?? "none";
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  session_id: ${sessionId}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
}
