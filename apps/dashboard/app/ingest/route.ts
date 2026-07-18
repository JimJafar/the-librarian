import type { NextRequest } from "next/server";
import { proxyAgentRequest } from "@/lib/agent-proxy";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Promise<Response> {
  return proxyAgentRequest(request, "/ingest");
}

export const POST = GET;

export function HEAD(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

export const OPTIONS = HEAD;
