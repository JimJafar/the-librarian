import "server-only";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { getAuthConfig } from "@/lib/auth-config-client";
import { resolveEnforcement } from "@/lib/auth-gate";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";
const ALLOWED_METHODS = new Set(["GET", "POST"]);
const STRIP_INBOUND = new Set(["host", "connection", "content-length", "authorization", "cookie"]);
const STRIP_OUTBOUND = new Set(["content-encoding", "transfer-encoding"]);

function serverUrl(): string {
  return process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

function isSameOrigin(req: NextRequest): boolean {
  // Sec-Fetch-Site is set by modern browsers for fetch() requests. We reject
  // only cross-site requests as a CSRF defence. "same-origin" (browser fetch),
  // "none" (direct navigation), and absent (server-side internal fetches,
  // older clients) are all accepted.
  return req.headers.get("sec-fetch-site") !== "cross-site";
}

async function proxy(req: NextRequest, segment: string): Promise<Response> {
  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!isSameOrigin(req)) {
    return new Response("Forbidden", { status: 403 });
  }
  // Critical: this proxy injects the admin bearer token, so when auth is enforced
  // it must require a session of its own — middleware does NOT cover API routes,
  // and without this the dashboard's admin power is reachable without logging in.
  // Enforcement is store-driven (D2.4); any non-"open" decision ("enforce" or the
  // fail-closed "block") requires a valid session. A thrown auth() (tampered JWT)
  // is a deny, not a 500 — mirrors the signIn callback in auth.ts.
  const enforcement = await resolveEnforcement(() => getAuthConfig());
  if (enforcement !== "open") {
    const session = await auth().catch(() => null);
    if (!session) return new Response("Unauthorized", { status: 401 });
  }

  const upstream = new URL(`${serverUrl()}/trpc/${segment}`);
  for (const [k, v] of req.nextUrl.searchParams.entries()) upstream.searchParams.append(k, v);

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (STRIP_INBOUND.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  const token = process.env.LIBRARIAN_ADMIN_TOKEN;
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit = hasBody
    ? { method: req.method, headers, body: await req.arrayBuffer(), redirect: "manual" }
    : { method: req.method, headers, redirect: "manual" };
  const upstreamRes = await fetch(upstream, init);

  const responseHeaders = new Headers(upstreamRes.headers);
  for (const k of STRIP_OUTBOUND) responseHeaders.delete(k);

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
  });
}

type Params = { params: Promise<{ trpc: string }> };

async function handler(req: NextRequest, ctx: Params): Promise<Response> {
  const { trpc } = await ctx.params;
  return proxy(req, trpc);
}

export { handler as GET, handler as POST };
