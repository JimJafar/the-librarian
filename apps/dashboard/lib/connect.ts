// "Connect a device" pure helpers (reference-ingest spec criterion 14/21;
// D2/D16/D17/D18). Kept free of React / server-only imports so both the server
// page and the client island can share them, and so the predicates are unit-
// testable in plain Node.

// The published "Clip to Librarian" iOS Shortcut (SPIKE-B). The Connect page
// renders it as a link AND a QR code. The link carries NO secret (D17) — on
// install the Shortcut prompts (Import Questions) for the user's server URL +
// capture token, which stay local to their device.
export const LIBRARIAN_SHORTCUT_ICLOUD_URL =
  "https://www.icloud.com/shortcuts/1c5f1204a45b47d2b8cc298d18ccee93";

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
