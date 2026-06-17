// Codex auto-capture adapter — POST-URL derivation + the network ship (testable).
// Spec 2026-06-16-harness-auto-capture, Phase 2A. Identical to the Claude ship
// (integrations/claude/scripts/lib/post.mjs) — the /transcript contract is
// harness-agnostic, so only the payload's `harness` field differs (built in
// transcript.mjs), not the transport.
//
// The endpoint is derived from the SAME public listener the MCP config already
// points at: `LIBRARIAN_MCP_URL` is `<origin>/mcp`, the transcript intake is
// `<origin>/transcript`. We rewrite the path on the same origin so a deployment
// configures one URL, not two (and a hostile redirect can't move it cross-origin
// — `redirect:"error"`).
//
// Auth is `Authorization: Bearer ${LIBRARIAN_AGENT_TOKEN}` — in the HEADER only,
// never the URL or a log (AGENTS.md: privacy is the product, tokens never leak).

/**
 * Derive the transcript-intake URL from `LIBRARIAN_MCP_URL`. Rewrites the path to
 * `/transcript` on the same origin, dropping any `/mcp` suffix, query, or hash.
 * Returns `null` for an unusable URL so the caller can fail-soft (skip, no throw).
 *
 * @param {string|undefined} mcpUrl
 * @returns {string|null}
 */
export function deriveTranscriptUrl(mcpUrl) {
  if (!mcpUrl || typeof mcpUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.origin}/transcript`;
}

/**
 * POST a delta payload to the transcript endpoint. Returns a small ack object —
 * `{ ok, status, buffered? }` — never throws on an HTTP error status (a non-2xx
 * is `ok:false`, which the caller treats as "do not advance the cursor"). A
 * network/transport failure DOES reject so the orchestrator's try/catch logs it
 * and skips — both are "do not advance".
 *
 * `redirect:"error"` (AGENTS.md): a 3xx must never bounce the Bearer token to a
 * different origin. A 10s timeout bounds a hung server so the hook can't hang.
 *
 * @param {string} url
 * @param {unknown} payload
 * @param {string} token
 * @returns {Promise<{ok:boolean, status:number, buffered?:number}>}
 */
export async function postDelta(url, payload, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    let buffered;
    try {
      const json = await response.json();
      if (json && typeof json === "object" && typeof json.buffered === "number") {
        buffered = json.buffered;
      }
    } catch {
      // Non-JSON / empty body — the status alone decides ok/not-ok.
    }
    return { ok: response.ok, status: response.status, buffered };
  } finally {
    clearTimeout(timer);
  }
}
