// Provider `${endpoint}/models` probe for the dashboard model picker + "test
// connection" (spec 042 §4, PR-B4b).
//
// Hard invariant (AGENTS.md): the bearer token travels ONLY in the Authorization
// header. It must never appear in a URL, log, thrown error, or returned error
// string. `redirect: "error"` forbids any 3xx so the token can't leak to another
// origin; an AbortController timeout means a hung endpoint can't block the admin's
// turn. Both helpers are fail-soft — they classify the failure into a short,
// token-free message and never re-raise.

const MODELS_TIMEOUT_MS = 10_000;

/** Result of a non-blocking connection probe. `error` is always token-free. */
export interface ProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * GET `${endpoint}/models` and return the model id list. Fail-soft: returns `[]`
 * on any error (unreachable, auth failure, malformed body) so the picker falls
 * back to free-text entry. Accepts the OpenAI `{ data: [{ id }] }` shape and a
 * bare `string[]`.
 */
export async function fetchProviderModels(endpoint: string, token: string): Promise<string[]> {
  const result = await getModels(endpoint, token);
  return result.ok ? result.models : [];
}

/**
 * Probe `${endpoint}/models` and report reachability without leaking the token.
 * Never throws — the `error` string is built only from HTTP status or the
 * transport error's own message, never from the request we sent.
 */
export async function probeProviderConnection(
  endpoint: string,
  token: string,
): Promise<ProbeResult> {
  const result = await getModels(endpoint, token);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}

type GetModelsResult = { ok: true; models: string[] } | { ok: false; error: string };

async function getModels(rawEndpoint: string, token: string): Promise<GetModelsResult> {
  const endpoint = rawEndpoint.trim().replace(/\/+$/, "");
  if (!endpoint) return { ok: false, error: "no endpoint configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    // Only attach the header when a token exists; some self-hosted endpoints are open.
    if (token) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetch(`${endpoint}/models`, {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      return { ok: false, error: transportError(err) };
    }

    if (!response.ok) {
      // Status only — the response body may echo provider detail but never our token.
      return { ok: false, error: `HTTP ${response.status}` };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, error: "response was not valid JSON" };
    }
    return { ok: true, models: extractModelIds(parsed) };
  } finally {
    clearTimeout(timer);
  }
}

// Node's fetch rejects with a DOMException on abort, which does NOT extend Error
// — match on `.name`. The error's own message (e.g. "ECONNREFUSED") is safe; it
// never contains the request we sent.
function transportError(err: unknown): string {
  if (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError") {
    return `timed out after ${MODELS_TIMEOUT_MS}ms`;
  }
  return err instanceof Error ? err.message : "network error";
}

// Tolerate the OpenAI `{ data: [{ id }] }` shape and a bare `string[]`; ignore
// anything malformed (yields []). Dedup + drop empties for a clean picker.
function extractModelIds(parsed: unknown): string[] {
  const raw = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.data)
      ? parsed.data
      : [];
  const ids = raw
    .map((entry) => (typeof entry === "string" ? entry : isRecord(entry) ? entry.id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
