// OpenCode auto-capture adapter — the OpenCode-runtime bridge (pure, testable).
// Spec 2026-06-16-harness-auto-capture, Phase 2A (OpenCode).
//
// The plugin entry (../librarian-capture.ts) hard-imports `@opencode-ai/plugin`
// (a Bun-runtime peer that is NOT a dependency of this monorepo), so it can't be
// unit-tested here. To keep that entry a THIN, logic-free shell, the two pieces of
// runtime glue it needs that DON'T themselves require the OpenCode types live here
// as plain `.mjs`, unit-tested with fakes:
//   - readSessionMessages: fetch the full session message list via the injected
//     SDK client, fail-soft (a reject / garbage shape → []).
//   - isSessionEndEvent : recognise the conversation-end signal for the
//     explicit-end accelerator (`ended:true`), scoped to THIS session.
//
// Node stdlib only — no `@opencode-ai/*` import — so vitest imports it directly.

/**
 * Read the full ordered message list for a session via the OpenCode SDK client.
 * The confirmed SDK surface is `client.session.messages({ path: { id } })`,
 * returning a hey-api result whose `.data` is `Array<{info,parts}>` (both roles).
 *
 * FAIL-SOFT (AGENTS.md: never throw out of the plugin): a missing client, a
 * rejected call (network/transport), or a non-array `.data` all resolve to `[]`
 * so the caller cleanly captures nothing this fire rather than crashing the hook.
 *
 * @param {{session?:{messages?:Function}}|undefined} client - the injected SDK client.
 * @param {string} sessionId
 * @returns {Promise<Array<{info?:unknown,parts?:unknown[]}>>}
 */
export async function readSessionMessages(client, sessionId) {
  try {
    const messages = client && client.session && client.session.messages;
    if (typeof messages !== "function") return [];
    const result = await messages.call(client.session, { path: { id: sessionId } });
    const data = result && typeof result === "object" ? result.data : undefined;
    return Array.isArray(data) ? data : [];
  } catch {
    // Network / transport / unexpected shape — capture nothing this fire.
    return [];
  }
}

/**
 * Does this OpenCode event signal that THIS session's conversation has gone idle
 * (the closest stable end-of-turn-batch signal OpenCode exposes)? Used as the
 * explicit-end accelerator: when true, the next capture ships `ended:true` so the
 * server settle-sweep extracts immediately instead of waiting out the idle window.
 * Scoped to `sessionId` so an idle in a CONCURRENT session never ends this one.
 *
 * FAIL-SOFT: garbage / a non-matching event → false (the server's idle settle
 * still handles timing — losing the accelerator is harmless).
 *
 * @param {{type?:string, properties?:{sessionID?:string}}|undefined} event
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionEndEvent(event, sessionId) {
  if (!event || typeof event !== "object") return false;
  if (event.type !== "session.idle") return false;
  const props = event.properties;
  const evSession = props && typeof props === "object" ? props.sessionID : undefined;
  // A session.idle scoped to this session is the end-of-batch signal.
  return evSession === sessionId;
}
