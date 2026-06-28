import { parseServerUrl } from "./server-url.js";
import type { CaptureConfig, IngestPayload, SendResult } from "./types.js";

/**
 * POST a capture payload to the server's `/ingest` endpoint and map the response
 * to a user-facing {@link SendResult} (spec criterion 23). This runs in the
 * BACKGROUND service worker, never the content script: a content-script fetch
 * from an https page to an http LAN server is mixed-content-blocked, whereas the
 * SW runs in the extension origin and (with the granted host permission) can
 * reach http (D26).
 *
 * Pure-ish: the `fetchImpl` is injected so the mapping is unit-testable without a
 * browser. The capture token is sent ONLY in the `Authorization` header and is
 * never logged, never placed in the URL, and never echoed into a result message.
 *
 * `redirect: "error"` so a 3xx can't bounce the Bearer token to another origin.
 */
export async function sendCapture(
  payload: IngestPayload,
  config: CaptureConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!config.serverUrl.trim() || !config.token.trim()) {
    return {
      ok: false,
      kind: "not-configured",
      message: "Not configured — set your server URL and capture token in the extension options.",
    };
  }

  let ingestUrl: string;
  try {
    ingestUrl = parseServerUrl(config.serverUrl).ingestUrl;
  } catch (error) {
    return {
      ok: false,
      kind: "not-configured",
      message:
        error instanceof Error
          ? error.message
          : "Invalid server URL — check the extension options.",
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
      redirect: "error",
    });
  } catch {
    // Network failure, DNS, TLS, mixed-content block, or a blocked redirect.
    // Deliberately does NOT include the thrown error (it can echo the URL/token).
    return {
      ok: false,
      kind: "network-error",
      message:
        "Couldn't reach your Librarian server — check the URL and that the server is running.",
    };
  }

  return mapResponse(response.status, await readId(response));
}

/** Try to read the ingest-log id from a 202 body; tolerate a non-JSON body. */
async function readId(response: Response): Promise<string | undefined> {
  try {
    const data = (await response.json()) as { id?: unknown };
    return typeof data.id === "string" ? data.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map an `/ingest` HTTP status to a teaching {@link SendResult}. Split out so the
 * status→message contract is exhaustively unit-testable. Statuses mirror the
 * server contract: 202 queued; 400 bad request; 401 bad/missing token; 403
 * wrong-scope token; 413 too big; 429 rate-limited; everything else a generic
 * server error.
 */
export function mapResponse(status: number, id: string | undefined): SendResult {
  switch (status) {
    case 202:
      return { ok: true, kind: "queued", message: "Queued ✓", ...(id ? { id } : {}) };
    case 400:
      return {
        ok: false,
        kind: "bad-request",
        message: "The server rejected the request (nothing to capture on this page).",
      };
    case 401:
      return {
        ok: false,
        kind: "unauthorized",
        message: "Unauthorized — check your capture token in the extension options.",
      };
    case 403:
      return {
        ok: false,
        kind: "forbidden",
        message:
          "Forbidden — that token isn't a capture token. Mint one on the dashboard's Connect a device page.",
      };
    case 413:
      return {
        ok: false,
        kind: "too-large",
        message: "Too large — this page's extracted content exceeds the server's size limit.",
      };
    case 429:
      return {
        ok: false,
        kind: "rate-limited",
        message: "Rate limited — you've hit the capture quota. Try again shortly.",
      };
    default:
      return {
        ok: false,
        kind: "server-error",
        message: `The server returned an error (HTTP ${status}). Check the ingest log on your dashboard.`,
      };
  }
}
