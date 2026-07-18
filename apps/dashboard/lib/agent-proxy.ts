import "server-only";
import type { NextRequest } from "next/server";
import { DASHBOARD_USER_HEADER } from "@/lib/dashboard-assertion";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const INGEST_BODY_LIMIT = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

const STRIP_INBOUND = new Set([
  "host",
  "connection",
  "content-length",
  "cookie",
  DASHBOARD_USER_HEADER,
]);
const STRIP_OUTBOUND = new Set(["content-encoding", "transfer-encoding"]);

export type AgentProxyPath = "/healthz" | "/primer.md" | "/mcp" | "/transcript" | "/ingest";

class BodyTooLargeError extends Error {}

function bodyLimit(path: AgentProxyPath): number {
  return path === "/ingest" ? INGEST_BODY_LIMIT : DEFAULT_BODY_LIMIT;
}

async function readBoundedBody(req: NextRequest, maxBytes: number): Promise<ArrayBuffer> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new BodyTooLargeError();
  if (req.body === null) return new ArrayBuffer(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function agentBaseUrl(): string {
  return process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

function proxyHeaders(req: NextRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (!STRIP_INBOUND.has(key.toLowerCase())) headers.set(key, value);
  }
  return headers;
}

export async function proxyAgentRequest(req: NextRequest, path: AgentProxyPath): Promise<Response> {
  if (process.env.LIBRARIAN_SINGLE_PORT !== "true") {
    return new Response("Not Found", { status: 404 });
  }

  const upstream = new URL(path, agentBaseUrl());
  upstream.search = req.nextUrl.search;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let body: ArrayBuffer | undefined;
  try {
    body = hasBody ? await readBoundedBody(req, bodyLimit(path)) : undefined;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      const limitMb = bodyLimit(path) / (1024 * 1024);
      return Response.json(
        { error: `Request body too large: the ${path} proxy cap is ${limitMb} MB` },
        { status: 413 },
      );
    }
    throw error;
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream, {
      method: req.method,
      headers: proxyHeaders(req),
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return Response.json({ error: "The Librarian agent service is unavailable." }, { status: 502 });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const key of STRIP_OUTBOUND) responseHeaders.delete(key);
  responseHeaders.set("cache-control", "no-store");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
