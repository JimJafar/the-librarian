// The dashboard's SETTER half of the identity-assertion contract (spec 065 SC 1 / SC 3).
//
// The server-side reader + the contract's meaning live in `@librarian/mcp-server/extension`
// (`readDashboardUser`, `DASHBOARD_USER_HEADER`, `DASHBOARD_USER_POISON`). This module is the
// dashboard's producer side: it encodes a session (or explicit anonymity) into the header value,
// and detects an Auth.js session cookie for the poison rule. It is deliberately SELF-CONTAINED —
// no `@librarian/mcp-server` runtime import — because it is pulled into Next's EDGE middleware
// bundle (via middleware.ts → auth-config-client.ts → trpc-server.ts), where a Node-only transitive
// import would break the bundle. The constants are therefore declared here and pinned equal to the
// server's exports by a drift-guard test (tests/dashboard-assertion.test.ts). Encoding uses only
// web-standard `TextEncoder`/`btoa` (available in both the Node and edge runtimes) — never `Buffer`.

/** MUST equal `DASHBOARD_USER_HEADER` from `@librarian/mcp-server/extension` (drift-guard test). */
export const DASHBOARD_USER_HEADER = "x-librarian-dashboard-user";
/** MUST equal `DASHBOARD_USER_POISON` from `@librarian/mcp-server/extension` (drift-guard test). */
export const DASHBOARD_USER_POISON = "invalid";
/** Encoded-size ceiling (SC 1); base64url is ASCII so string length IS byte length. */
export const MAX_DASHBOARD_USER_BYTES = 4096;

/** Auth.js v5 (@auth/core 0.41.2) session-cookie base names — secure and non-secure variants. */
const SESSION_COOKIE_BASES = ["authjs.session-token", "__Secure-authjs.session-token"] as const;

/** A user assertion's claims (SC 1). Mirrors `DashboardUser` on the server side. */
export interface DashboardUserClaims {
  provider: string;
  sub: string;
  email?: string;
  name?: string;
}

/** The two claim shapes the setter can encode. */
export type DashboardAssertionClaims = { anon: true } | DashboardUserClaims;

/** base64url(UTF-8) with web APIs only (edge- and node-safe): TextEncoder → binary string → btoa. */
function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encode claims into the header value, or the poison marker when they cannot be honestly carried.
 * The SETTER enforces the 4 KB cap (SC 1): it NEVER omits the header for a browser-origin request
 * and NEVER sends an oversize value — if encoding fails or overflows the cap, it sends the poison
 * marker instead, which the reader refuses (rather than an absent header, which it would trust).
 */
export function encodeDashboardAssertion(claims: DashboardAssertionClaims): string {
  let encoded: string;
  try {
    encoded = base64urlEncode(JSON.stringify(claims));
  } catch {
    return DASHBOARD_USER_POISON;
  }
  if (encoded.length > MAX_DASHBOARD_USER_BYTES) return DASHBOARD_USER_POISON;
  return encoded;
}

/** Convenience: the anonymous assertion's fixed header value. */
export function anonymousAssertion(): string {
  return encodeDashboardAssertion({ anon: true });
}

/**
 * Build user claims from a resolved session's fields, or `null` when a stable subject is missing
 * (no `provider`+`sub` pair). `provider`/`sub` are trimmed; `email`/`name` are optional display
 * material. Decoupled from the `next-auth` Session type so this module stays import-light.
 */
export function userClaimsFromSession(fields: {
  provider?: string | null | undefined;
  sub?: string | null | undefined;
  email?: string | null | undefined;
  name?: string | null | undefined;
}): DashboardUserClaims | null {
  const provider = fields.provider?.trim();
  const sub = fields.sub?.trim();
  if (!provider || !sub) return null;
  const claims: DashboardUserClaims = { provider, sub };
  if (fields.email) claims.email = fields.email;
  if (fields.name) claims.name = fields.name;
  return claims;
}

/**
 * Whether any of the given cookie names is an Auth.js session cookie — matched by NAME PREFIX so
 * a CHUNKED session (over ~4 KB, split into `name.0`, `name.1`, … by @auth/core 0.41.2) still
 * counts (spec 065 SC 3 / §1 chunking fact). Detecting by the two exact base names alone would
 * read a chunked session as "no cookie" and mis-classify a chunked-then-expired session as a
 * machine context (absent → admin) instead of poisoning it.
 */
export function hasSessionCookie(cookieNames: Iterable<string>): boolean {
  for (const name of cookieNames) {
    for (const base of SESSION_COOKIE_BASES) {
      if (name === base || name.startsWith(`${base}.`)) return true;
    }
  }
  return false;
}
