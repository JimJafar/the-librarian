import "server-only";
import type { AppRouter } from "@librarian/mcp-server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  DASHBOARD_USER_HEADER,
  DASHBOARD_USER_POISON,
  anonymousAssertion,
  encodeDashboardAssertion,
  hasSessionCookie,
  userClaimsFromSession,
} from "@/lib/dashboard-assertion";
import { resolveTrpcBaseUrl } from "@/lib/trpc-server-bare";

// The IDENTITY-BEARING server tRPC client (spec 065 SC 3). Every RSC page and server action rides
// this singleton, and every request it makes carries the dashboard identity assertion — who the
// call is on behalf of — derived per request by `dashboardIdentityHeaders` below. The AUTH
// BOOTSTRAP traffic (the auth-config fetch, credentials verifyPassword, the break-glass reset
// redemption) rides the BARE client in trpc-server-bare.ts instead: those flows run before any
// session can exist AND `auth()` itself depends on them, so an identity callback here that awaited
// `auth()` would deadlock on every cold config cache (spec 065 §4 "two clients").
export { resolveTrpcBaseUrl } from "@/lib/trpc-server-bare";

// ── The scope discriminator (spec 065 SC 3, pinned) ─────────────────────────────────────────────
//
// The callback's rows 4 and 5 route THROWS to OPPOSITE trust outcomes (no header = machine trust;
// poison = refusal), so which throw means what cannot be left to chance. The rule is an ALLOW-LIST
// OF ONE: the callback probes `cookies()` FIRST, and the ONLY probe throw mapped to "no header" is
// Next's outside-request-scope error — identified by its documented shape below and PINNED against
// the installed `next` by a unit test (tests/trpc-server-identity-scope.test.ts), so version drift
// fails loudly. EVERY other probe throw is RE-THROWN: that re-throws the prerender-bailout
// control-flow error (`DYNAMIC_SERVER_USAGE` — the route correctly becomes dynamic), fails a
// `dynamic = "error"` page's build loudly (`NEXT_STATIC_GEN_BAILOUT`) instead of baking
// admin-fetched data into anonymous HTML, and fails loudly in `after()`/cache scopes where identity
// is undeterminable. An unrecognised probe throw must never default to machine trust.
const OUTSIDE_REQUEST_SCOPE_CODE = "E251";
const OUTSIDE_REQUEST_SCOPE_MESSAGE = "was called outside a request scope";

function isOutsideRequestScopeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { __NEXT_ERROR_CODE?: unknown }).__NEXT_ERROR_CODE;
  // The documented shape: code E251 (next 15.5.x), with the message as the fallback signal should
  // a future next drop the (non-enumerable) code property. A DIFFERENT code present on the error
  // is a different error class — never map it to machine trust.
  if (code !== undefined) return code === OUTSIDE_REQUEST_SCOPE_CODE;
  return error.message.includes(OUTSIDE_REQUEST_SCOPE_MESSAGE);
}

/**
 * The per-request identity headers callback (spec 065 SC 3) — the five-row table:
 *
 *   1. session resolves                                → the USER assertion;
 *   2. request scope, no session, session cookie present (by NAME PREFIX, chunk suffixes
 *      included — an expired/undecodable session must refuse, not become machine trust)
 *                                                      → the POISON marker;
 *   3. request scope, no session cookie at all         → `{anon:true}` — a sessionless RSC render
 *      or server action is BROWSER-triggered work, refusable under a member-aware provider;
 *   4. no request scope (module init, at build or in the edge bundle) → NO header — the genuinely
 *      machine contexts, which with the bare bootstrap client are the ONLY producers of absence;
 *   5. session resolution throws inside request scope  → the POISON marker.
 *
 * `@/auth` is imported LAZILY (a static import would cycle: auth.ts is upstream of this module's
 * consumers), and this callback NEVER throws its own failures — any failure after the `cookies()`
 * probe resolved is row 5 (poison), never a throw into the calling query and never machine trust.
 */
export async function dashboardIdentityHeaders(): Promise<Record<string, string>> {
  let cookieNames: string[];
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    cookieNames = jar.getAll().map((cookie) => cookie.name);
  } catch (error) {
    // The allow-list of one: ONLY the pinned outside-request-scope shape means "machine context".
    if (isOutsideRequestScopeError(error)) return {};
    throw error;
  }

  // The probe resolved: we are inside a request scope. From here every failure is row 5 (poison).
  try {
    if (!hasSessionCookie(cookieNames)) {
      return { [DASHBOARD_USER_HEADER]: anonymousAssertion() };
    }
    const { auth } = await import("@/auth");
    const session = await auth();
    const claims = session?.user
      ? userClaimsFromSession({
          provider: session.user.provider,
          sub: session.user.sub,
          email: session.user.email,
          name: session.user.name,
        })
      : null;
    return {
      [DASHBOARD_USER_HEADER]: claims ? encodeDashboardAssertion(claims) : DASHBOARD_USER_POISON,
    };
  } catch {
    return { [DASHBOARD_USER_HEADER]: DASHBOARD_USER_POISON };
  }
}

export function createServerTRPC() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${resolveTrpcBaseUrl()}/trpc`,
        // Per-request (per batch) identity assertion — SC 3's five-row table above.
        headers: () => dashboardIdentityHeaders(),
      }),
    ],
  });
}

export const serverTRPC = createServerTRPC();
