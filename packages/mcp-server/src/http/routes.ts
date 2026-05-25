// HTTP request dispatcher.
//
// Pure routing layer over the LibrarianStore — no env, no boot-time
// validation. `createRouteHandler(deps)` returns the handler function
// the `node:http` server calls per request.
//
// Surface (post-T7.1): `/healthz`, `/mcp`, `/trpc/*`. The legacy
// dashboard file serves (`/`, `/styles.css`, `/app.js`) and `/api/*`
// REST routes are retired — the new Next.js dashboard at apps/dashboard
// is the canonical admin surface and uses Server Actions + browser
// tRPC. Anything else 404s.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { LibrarianStore } from "@librarian/core";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { handleMcpPayload } from "../mcp/rpc.js";
import { createContextFactory } from "../trpc/context.js";
import { appRouter } from "../trpc/router.js";
import { type AuthConfig, authenticateMcp, isAllowedOrigin } from "./auth.js";

export interface RouteDeps {
  store: LibrarianStore;
  auth: AuthConfig;
  maxBodyBytes: number;
  secretKey: Buffer | null;
}

export function createRouteHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, auth, maxBodyBytes, secretKey } = deps;

  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext: createContextFactory({ store, auth, secretKey }),
    basePath: "/trpc/",
  });

  return async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, {
          status: "ok",
          dashboard_auth: "disabled",
          mcp_auth: auth.adminToken ? "enabled" : "disabled",
          auth: auth.adminToken ? "enabled" : "disabled",
          agent_auth: auth.agentToken || auth.agentTokenMap.size ? "enabled" : "disabled",
        });
      }

      if (!isAllowedOrigin(req, auth)) return sendJson(res, { error: "Origin not allowed" }, 403);

      if (url.pathname.startsWith("/trpc/")) {
        return trpcHandler(req, res);
      }

      if (url.pathname === "/mcp") {
        const result = authenticateMcp(req, auth);
        if (!result) return sendUnauthorized(res);
        if (req.method === "GET") {
          return sendJson(res, {
            status: "ok",
            transport: "json-rpc-http",
            message: "POST JSON-RPC MCP messages to this endpoint.",
          });
        }
        if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
        const payload = await readJson(req, maxBodyBytes);
        const response = await handleMcpPayload(store, payload, {
          role: result.role,
          agentId: result.agentId,
        });
        if (response === null) return sendEmpty(res);
        return sendJson(res, response);
      }

      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      sendJson(res, { error: err.message }, err.statusCode || 500);
    }
  };
}

// ---------- HTTP IO helpers ----------

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendEmpty(res: ServerResponse): void {
  res.writeHead(202, { "cache-control": "no-store" });
  res.end();
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": "Bearer",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

async function readJson(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError("Request body too large", 413);
    body += chunk;
  }
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw httpError(`Invalid JSON body: ${(error as Error).message}`, 400);
  }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}
