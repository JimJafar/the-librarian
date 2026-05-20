import "server-only";
import type { NextRequest } from "next/server";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";
const ALLOWED_METHODS = new Set(["GET", "POST"]);
const STRIP_INBOUND = new Set(["host", "connection", "content-length", "authorization", "cookie"]);
const STRIP_OUTBOUND = new Set(["content-encoding", "transfer-encoding"]);

function serverUrl(): string {
  return process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

function isSameOrigin(req: NextRequest): boolean {
  // Sec-Fetch-Site is set by all modern browsers for fetch() requests; we
  // require "same-origin" so cross-site form submissions can't drive admin
  // tRPC mutations through this proxy. CLI / non-browser callers should
  // talk to the mcp-server directly, not via the dashboard origin.
  return req.headers.get("sec-fetch-site") === "same-origin";
}

async function proxy(req: NextRequest, segment: string): Promise<Response> {
  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!isSameOrigin(req)) {
    return new Response("Forbidden", { status: 403 });
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
