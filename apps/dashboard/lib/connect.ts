// "Connect a device" pure helpers (reference-ingest spec criterion 14/21;
// D2/D16/D17/D18). Kept free of React / server-only imports so both the server
// page and the client island can share them, and so the predicates are unit-
// testable in plain Node.

// The published "Clip to Librarian" iOS Shortcut (SPIKE-B). The Connect page
// renders it as a link AND a QR code. The link carries NO secret (D17) — on
// install the Shortcut prompts (Import Questions) for the user's server URL +
// capture token, which stay local to their device.
export const LIBRARIAN_SHORTCUT_ICLOUD_URL =
  "https://www.icloud.com/shortcuts/428c3d7539da4ca382c9e0d4daa6226f";

/**
 * Is the server URL plaintext HTTP? The capture token travels in the request to
 * `/ingest`, so an `http://` origin means the token crosses the wire in the
 * clear (D18). We warn prominently when so. `https://` is fine; an empty/unknown
 * URL is NOT flagged (nothing to warn about until the user supplies one).
 *
 * Matches the scheme only — `http://` but not `https://` — case-insensitively.
 */
export function isInsecureServerUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^http:\/\//i.test(url.trim());
}

/**
 * The public server URL the capture clients POST to (the agent-facing origin,
 * NOT the internal tRPC listener). Resolved from the env the dashboard already
 * knows; empty string when unset so the page can prompt the operator to confirm
 * it rather than display a wrong default.
 *
 * NOTE: in the standard deployment this is the dashboard's INTERNAL view of the
 * mcp-server (e.g. `http://127.0.0.1:3838` or `http://mcp-server:3838`, ADR
 * 0001) — the right PORT but an internal HOST that external capture clients
 * can't reach. {@link resolveDisplayServerUrl} fixes the host client-side.
 */
export function resolvePublicServerUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.LIBRARIAN_PUBLIC_URL ??
    env.LIBRARIAN_MCP_URL ??
    env.LIBRARIAN_SERVER_URL ??
    ""
  ).trim();
}

/**
 * Hosts only reachable from inside the deployment — never the address an external
 * capture client (extension / phone) uses: loopback, the wildcard bind, and a
 * bare single-label name (a docker-compose service like `mcp-server`).
 */
export function isInternalHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h === "::") {
    return true;
  }
  // A bare single-label hostname (no dot, not an IPv6 literal) is a container/LAN
  // name, not a public address.
  return !h.includes(".") && !h.includes(":");
}

/**
 * The Server URL to DISPLAY on the Connect page. The server only knows its
 * INTERNAL view of the mcp-server (`resolvePublicServerUrl`), so when that host
 * is internal/empty we swap in the host the admin actually reached this dashboard
 * at (`window.location.hostname`) while KEEPING the configured mcp-server port —
 * the dashboard and mcp-server are separate ports (3000 vs 3838, ADR 0001), so we
 * must not borrow the dashboard's port. An already-external configured URL is
 * respected unchanged. The field stays editable for non-standard topologies.
 */
export function resolveDisplayServerUrl(
  configured: string,
  location: { protocol: string; hostname: string },
): string {
  let parsed: URL | null = null;
  try {
    parsed = configured ? new URL(configured) : null;
  } catch {
    parsed = null;
  }
  // An explicitly-configured external URL is authoritative — leave it alone.
  if (parsed && !isInternalHost(parsed.hostname)) return configured.trim();
  const port = parsed?.port ? `:${parsed.port}` : "";
  return `${location.protocol}//${location.hostname}${port}`;
}
