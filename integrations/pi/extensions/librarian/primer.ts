// Primer injection via `before_agent_start` (rethink spec §5.2, D9).
//
// The Librarian teaches agents through one ≤2KB primer served unauthenticated
// at `GET /primer.md` on the server root (the same document every other
// harness sees). This module fetches it once per process, caches it, and
// appends it to Pi's system prompt — the thinnest native channel Pi offers.
//
// Fail-soft contract (AGENTS.md §2): every failure path yields an empty primer
// and an unchanged system prompt. The user's turn is never blocked; a fetch
// failure is retried on the next turn rather than cached.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_MS = 5_000;
// The server enforces ≤2KB on save; 64KB of headroom keeps the cap a pure
// runaway-endpoint guard rather than a contract we could trip on first.
const DEFAULT_MAX_BYTES = 64 * 1024;

export interface PrimerSourceConfig {
  /** The configured LIBRARIAN_MCP_URL (usually `https://host/mcp`). */
  endpoint: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the primer URL from the MCP endpoint. The primer is served at the
 * SERVER ROOT (`/primer.md`), not under `/mcp` — root-relative resolution
 * strips the endpoint's path. Returns null for an unparseable endpoint.
 */
export function primerUrl(endpoint: string): string | null {
  try {
    return new URL("/primer.md", endpoint).toString();
  } catch {
    return null;
  }
}

/**
 * Build a per-process primer source: the first successful fetch is cached for
 * the lifetime of the process; failures return "" WITHOUT caching so a later
 * turn can retry once the server is back.
 */
export function createPrimerSource(config: PrimerSourceConfig): () => Promise<string> {
  const url = primerUrl(config.endpoint);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = config.fetchImpl ?? fetch;
  let cached: string | null = null;

  return async function getPrimer(): Promise<string> {
    if (cached !== null) return cached;
    if (!url) return "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // No Authorization header: /primer.md is unauthenticated by design, so
      // the bearer token has no business on this request. Redirects are
      // refused to match the MCP client's posture (and a primer has no
      // legitimate 3xx).
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) return "";
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) return "";
      cached = text;
      return cached;
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Wire the primer into Pi's system prompt. `before_agent_start` fires once per
 * turn after Pi assembles the system prompt; the SDK chains multiple
 * extensions' `systemPrompt` returns, so this append cooperates with any other
 * extension that also augments the prompt. Empty primer → no return value →
 * Pi leaves the prompt untouched.
 */
export function registerPrimerHook(pi: ExtensionAPI, getPrimer: () => Promise<string>): void {
  pi.on("before_agent_start", async (event) => {
    try {
      const primer = await getPrimer();
      if (!primer.trim()) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${primer}` };
    } catch {
      // Defensive net — getPrimer already swallows its own errors, but a
      // top-level throw must never break the user's turn.
      return;
    }
  });
}
