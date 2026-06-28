// Server-URL normalization + the http:// warning predicate (spec D18 / D26).
//
// The user pastes a base server URL (e.g. `https://librarian.example.com` or
// `http://192.168.1.10:8080`). We normalize it to a canonical origin, derive the
// `/ingest` endpoint, the host-permission match pattern for
// `chrome.permissions.request`, and a predicate that drives the plaintext-token
// warning.

export interface ParsedServerUrl {
  /** Canonical `protocol//host[:port]` with no trailing slash. */
  origin: string;
  /** The full POST target: `<origin>/ingest`. */
  ingestUrl: string;
  /** Host-permission match pattern for `chrome.permissions.request`: `<origin>/*`. */
  originPattern: string;
  /** True when the configured server uses plaintext http (drives the warning). */
  insecure: boolean;
  /** True when the host is a loopback/localhost target (the http caveat is softer). */
  loopback: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Parse + normalize a user-entered server URL. Accepts input with or without a
 * trailing slash or path; a bare `host:port` (no scheme) is rejected rather than
 * silently assumed http/https — the warning logic depends on a known scheme.
 *
 * @throws {Error} with a teaching message when the URL is unparseable or not
 *   http(s). Callers surface the message verbatim in the options UI.
 */
export function parseServerUrl(raw: string): ParsedServerUrl {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Enter your Librarian server URL, e.g. https://librarian.example.com");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Could not parse "${trimmed}" as a URL. Include the scheme, e.g. https://librarian.example.com`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Expected an http:// or https:// URL, got "${parsed.protocol}//…". Use your Librarian server's address.`,
    );
  }

  const origin = `${parsed.protocol}//${parsed.host}`;
  const host = parsed.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");

  return {
    origin,
    ingestUrl: `${origin}/ingest`,
    originPattern: `${origin}/*`,
    insecure: parsed.protocol === "http:",
    loopback,
  };
}

/**
 * True when the configured server URL warrants the plaintext-token warning
 * (D18): any `http://` target. Returns `false` for unparseable input — the
 * parse error is the relevant message in that case, not the http warning.
 */
export function isInsecureServer(raw: string): boolean {
  try {
    return parseServerUrl(raw).insecure;
  } catch {
    return false;
  }
}
