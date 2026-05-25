// Dashboard page gating (A2; D2.4 made it store-driven + fail-closed).
//
// Enforcement is resolved per request from the store auth-config (cached), with the
// legacy LIBRARIAN_AUTH_ENABLED env as the fallback:
//   - open    → serve (never touch the auth() wrapper, which needs AUTH_SECRET)
//   - enforce → redirect any unauthenticated request to /login
//   - block   → an enabled-but-incomplete config, or an unreachable store: refuse to
//               serve with a store-independent page that names the CLI break-glass,
//               so a store outage can't silently fail OPEN.
//
// The matcher excludes ALL of /api — middleware is the wrong layer to protect API
// routes (it can be skipped), so the security-critical /api/trpc proxy gates itself
// with the same enforcement (see app/api/trpc/[trpc]/route.ts). /login is excluded
// so the redirect can't loop, and so the owner can still reach it under "block".

import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAuthConfig } from "@/lib/auth-config-client";
import { resolveEnforcement } from "@/lib/auth-gate";

// The auth() wrapper decodes the session and redirects unauthenticated requests.
// Invoked only on the "enforce" path so the un-enforced default never reaches it.
// auth() returns a handler that is middleware-compatible at runtime (it's the shape
// Next calls as a default middleware export); cast to the middleware signature so we
// can invoke it manually with the NextFetchEvent.
const enforce = auth((req) =>
  req.auth ? NextResponse.next() : NextResponse.redirect(new URL("/login", req.nextUrl.origin)),
) as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>;

function blockResponse(): NextResponse {
  // Store-independent: no rendering that itself needs the store. Names the recovery.
  const body = `<!doctype html><meta charset="utf-8"><title>Authentication unavailable</title>
<h1>Authentication is unavailable</h1>
<p>The dashboard cannot verify its authentication configuration (the store is
unreachable or the config is incomplete), so it is refusing to serve — failing
closed rather than open.</p>
<p>On the server host, run <code>the-librarian auth disable</code> to turn off
enforcement (break-glass), then fix the configuration.</p>`;
  return new NextResponse(body, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async function middleware(
  req: NextRequest,
  ev: NextFetchEvent,
): Promise<Response | undefined> {
  const decision = await resolveEnforcement(() => getAuthConfig());
  if (decision === "open") return NextResponse.next();
  if (decision === "block") return blockResponse();
  return enforce(req, ev);
}

export const config = {
  // Anchor each excluded segment so prefix lookalikes (e.g. /loginhelp, /apidocs)
  // are still gated — only the exact /api, /_next, /login subtrees and favicon are
  // skipped.
  matcher: ["/((?!api(?:/|$)|_next/|favicon.ico|login(?:/|$)).*)"],
};
