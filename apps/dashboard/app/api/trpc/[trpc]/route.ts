import "server-only";
import type { NextRequest } from "next/server";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";

function serverUrl(): string {
  return process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

async function proxy(req: NextRequest, segments: string[]): Promise<Response> {
  const upstream = new URL(`${serverUrl()}/trpc/${segments.join("/")}`);
  for (const [k, v] of req.nextUrl.searchParams.entries()) upstream.searchParams.append(k, v);

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") continue;
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
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("transfer-encoding");

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
  });
}

type Params = { params: Promise<{ trpc: string[] }> };

async function handler(req: NextRequest, ctx: Params): Promise<Response> {
  const { trpc } = await ctx.params;
  return proxy(req, trpc);
}

export { handler as GET, handler as POST, handler as PUT, handler as DELETE, handler as PATCH };
