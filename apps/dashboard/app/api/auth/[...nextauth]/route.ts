// Auth.js v5 route handler for /api/auth/* (sign-in, callback, csrf, session,
// sign-out). D3.2 wraps the credentials callback POST with a per-client rate limit —
// defense in depth atop the store-side lockout — returning a generic 429 (no user or
// lockout-state enumeration). All other auth routes pass straight through.

import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { createRateLimiter } from "@/lib/rate-limit";

const CREDENTIALS_PATH = "/api/auth/callback/credentials";
// ~10 attempts/minute per client before the dashboard itself starts refusing
// (tunable via env — e.g. e2e raises it so the store-side lockout is the gate under test).
const RATE_LIMIT = Number(process.env.LIBRARIAN_CREDENTIALS_RATE_LIMIT) || 10;
const limiter = createRateLimiter({ limit: RATE_LIMIT, windowMs: 60_000 });

function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "global";
}

export const GET = handlers.GET;

export async function POST(req: NextRequest): Promise<Response> {
  if (req.nextUrl.pathname === CREDENTIALS_PATH && !limiter.check(clientKey(req))) {
    return new Response("Too many sign-in attempts. Please wait and try again.", {
      status: 429,
      headers: { "cache-control": "no-store" },
    });
  }
  return handlers.POST(req);
}
