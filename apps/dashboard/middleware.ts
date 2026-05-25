// A2: dashboard page gating. When auth is enforced, an unauthenticated request
// to any matched (non-excluded) page is redirected to /login.
//
// The matcher excludes ALL of /api on purpose — middleware is the wrong layer to
// protect API routes (it can be skipped for them), so the security-critical
// /api/trpc proxy gates itself with auth() (see app/api/trpc/[trpc]/route.ts).
// /api/auth (the OAuth flow) and /api/health (liveness) must also stay open, and
// excluding /api covers both. /login is excluded so the redirect can't loop.

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAuthEnforced } from "@/lib/auth-gate";

// Decided once at module init (the flag is a deploy-time setting; flipping it
// needs a restart, which env changes require anyway). This matters: the auth()
// wrapper ALWAYS decodes the session, which errors loudly when AUTH_SECRET is
// unset — so the default, un-enforced deployment must never reach the wrapper.
// When enforced, redirect any unauthenticated request to /login.
export default isAuthEnforced()
  ? auth((req) =>
      req.auth ? NextResponse.next() : NextResponse.redirect(new URL("/login", req.nextUrl.origin)),
    )
  : () => NextResponse.next();

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|login).*)"],
};
