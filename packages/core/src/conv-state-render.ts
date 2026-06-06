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
 * Shape (D16 dropped `domain`; sessions retired → `session_id` dropped too,
 * since the lifecycle that populated it is gone and it was always `none`):
 *
 *   <conversation-state>
 *     conv_id: <id>
 *     off_record: <true|false>
 *   </conversation-state>
 */
export function renderConvStateBlock(state: ConversationState | null): string {
  if (!state) return "";
  const offRecord = state.off_record ? "true" : "false";
  return [
    "<conversation-state>",
    `  conv_id: ${state.conv_id}`,
    `  off_record: ${offRecord}`,
    "</conversation-state>",
  ].join("\n");
}

/**
 * Render the awareness primer block (spec 041, feature 1B — Decision 2).
 *
 * The primer is a short, server-sourced note injected on every harness turn
 * telling the model that The Librarian exists and which verbs to reach for. It
 * rides the SAME per-turn injection channel as `renderConvStateBlock`, but is a
 * SEPARATE `<librarian>` block — it is static awareness, not per-turn state, so
 * it is deliberately not folded into `<conversation-state>`.
 *
 * Returns the empty string when `primer` is empty — that is the contract that
 * lets the operator DISABLE the primer (an empty `awareness.primer` setting) and
 * keeps the read fail-soft (an unreadable store degrades to `""` → no block).
 *
 * This is the CANONICAL reference: each of the five plugins (Tasks A3–A7)
 * replicates a byte-identical `renderAwarenessPrimer` locally (AGENTS.md §2 "five
 * peer implementations" rule). The exact bytes below are the source of truth —
 * the model consumes a stable byte sequence every turn across all harnesses.
 *
 * Shape:
 *
 *   <librarian>
 *   <primer text>
 *   </librarian>
 */
export function renderAwarenessPrimer(primer: string): string {
  if (!primer) return "";
  return ["<librarian>", primer, "</librarian>"].join("\n");
}
