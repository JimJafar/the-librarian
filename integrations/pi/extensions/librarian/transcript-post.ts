// Auto-capture POST-URL derivation + the network ship (Phase 2B / T-Pi).
//
// The endpoint is derived from the SAME public listener the MCP config already
// points at: `LIBRARIAN_MCP_URL` is `<origin>/mcp`, the transcript intake is
// `<origin>/transcript`. We rewrite the path on the same origin so a deployment
// configures one URL, not two (and a hostile redirect can't move it cross-origin
// — `redirect:"error"` below).
//
// Auth is `Authorization: Bearer ${LIBRARIAN_AGENT_TOKEN}` — in the HEADER only,
// never the URL or a log (AGENTS.md: privacy is the product, tokens never leak).
// Mirrors the Claude adapter's post.mjs and the Pi mcp-client's security posture.
//
// RUNTIME-IMPORT NOTE: uses only the global `fetch` / `URL` / `AbortController`
// (no imports at all), so it loads in a git/local Pi install with no node_modules.

const SHIP_TIMEOUT_MS = 10_000;

/** The small ack the orchestrator folds into its advance-on-2xx decision. */
export interface CaptureAck {
  ok: boolean;
  status: number;
  buffered?: number;
}

/**
 * Derive the transcript-intake URL from `LIBRARIAN_MCP_URL`. Rewrites the path to
 * `/transcript` on the same origin, dropping any `/mcp` suffix, query, or hash.
 * Returns `null` for an unusable / non-http(s) URL so the caller can fail-soft
 * (skip, no throw).
 */
export function deriveTranscriptUrl(mcpUrl: string | undefined): string | null {
  if (!mcpUrl || typeof mcpUrl !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.origin}/transcript`;
}

/**
 * POST a delta payload to the transcript endpoint. Returns a small ack —
 * `{ ok, status, buffered? }` — never throws on an HTTP error status (a non-2xx
 * is `ok:false`, which the caller treats as "do not advance seq"). A
 * network/transport failure (DNS, ECONNREFUSED, timeout, a refused redirect) DOES
 * reject so the orchestrator's try/catch logs it and skips — both are "do not
 * advance".
 *
 * `redirect:"error"` (AGENTS.md): a 3xx must never bounce the Bearer token to a
 * different origin. A 10s timeout bounds a hung server so the hook can't hang.
 */
export async function postDelta(url: string, payload: unknown, token: string): Promise<CaptureAck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHIP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The token lives ONLY here — never in the URL or any logged string.
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    let buffered: number | undefined;
    try {
      const json: unknown = await response.json();
      if (
        json &&
        typeof json === "object" &&
        typeof (json as { buffered?: unknown }).buffered === "number"
      ) {
        buffered = (json as { buffered: number }).buffered;
      }
    } catch {
      // Non-JSON / empty body — the status alone decides ok/not-ok.
    }
    const ack: CaptureAck = { ok: response.ok, status: response.status };
    if (buffered !== undefined) ack.buffered = buffered;
    return ack;
  } finally {
    clearTimeout(timer);
  }
}
