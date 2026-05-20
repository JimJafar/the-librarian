// HTTP request dispatcher.
//
// Pure routing layer over the LibrarianStore — no env, no boot-time
// validation. `createRouteHandler(deps)` returns the handler function
// the `node:http` server calls per request.

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DEFAULT_AGENT_ID, type LibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "../mcp/rpc.js";
import { type AuthConfig, authenticateMcp, isAllowedOrigin } from "./auth.js";

export interface RouteDeps {
  store: LibrarianStore;
  auth: AuthConfig;
  publicDir: string;
  maxBodyBytes: number;
}

export function createRouteHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, auth, publicDir, maxBodyBytes } = deps;

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

      if (req.method === "GET" && url.pathname === "/") {
        return sendFile(res, publicDir, "index.html", "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/styles.css") {
        return sendFile(res, publicDir, "styles.css", "text/css; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/app.js") {
        return sendFile(res, publicDir, "app.js", "text/javascript; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, {
          memories: store.listAll({}),
          events: store.readEvents().slice(-200).reverse(),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/aggregates") {
        return sendJson(res, store.getAggregates());
      }

      const relatedMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/related$/);
      if (req.method === "GET" && relatedMatch) {
        const result = store.getRelated(relatedMatch[1] as string);
        if (!result) return sendJson(res, { error: "Not found" }, 404);
        return sendJson(res, result);
      }

      if (req.method === "GET" && url.pathname === "/api/memories") {
        const result = store.listMemories({
          status: url.searchParams.get("status") || "",
          agent_id: url.searchParams.get("agent_id") || "",
          project_key: url.searchParams.get("project_key") || "",
          category: url.searchParams.get("category") || "",
          visibility: url.searchParams.get("visibility") || "",
          scope: url.searchParams.get("scope") || "",
          from: url.searchParams.get("from") || "",
          to: url.searchParams.get("to") || "",
          sort: url.searchParams.get("sort") || "updated_at",
          order: url.searchParams.get("order") || "desc",
          limit: Number(url.searchParams.get("limit") || 100),
          offset: Number(url.searchParams.get("offset") || 0),
        });
        return sendJson(res, result);
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        return sendJson(
          res,
          store.listEvents({
            type: url.searchParams.get("type") || "",
            agent_id: url.searchParams.get("agent_id") || "",
            memory_id: url.searchParams.get("memory_id") || "",
            result: url.searchParams.get("result") || "",
            query: url.searchParams.get("query") || "",
            limit: Number(url.searchParams.get("limit") || 25),
            offset: Number(url.searchParams.get("offset") || 0),
          }),
        );
      }

      if (req.method === "POST" && url.pathname === "/api/memories") {
        const body = await readJson(req, maxBodyBytes);
        const result = store.createMemory(body);
        return sendJson(res, result);
      }

      const updateMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/update$/);
      if (req.method === "POST" && updateMatch) {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(
          res,
          store.updateMemory(
            updateMatch[1] as string,
            (body.patch as Record<string, unknown>) || body,
            (body.agent_id as string) || "dashboard",
            { allowProtected: true },
          ),
        );
      }

      const deleteMatch = url.pathname.match(/^\/api\/memories\/([^/]+)\/delete$/);
      if (req.method === "POST" && deleteMatch) {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(
          res,
          store.deleteMemory(deleteMatch[1] as string, (body.agent_id as string) || "dashboard"),
        );
      }

      const approveMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/approve$/);
      if (req.method === "POST" && approveMatch) {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(
          res,
          store.approveProposal(
            approveMatch[1] as string,
            "approve",
            (body.patch as Record<string, unknown>) || {},
            (body.agent_id as string) || "dashboard",
          ),
        );
      }

      const rejectMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/reject$/);
      if (req.method === "POST" && rejectMatch) {
        const body = await readJson(req, maxBodyBytes);
        return sendJson(
          res,
          store.approveProposal(
            rejectMatch[1] as string,
            "reject",
            {},
            (body.agent_id as string) || "dashboard",
          ),
        );
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const result = store.listSessions({
          admin: true,
          project_key: url.searchParams.get("project_key") || "",
          harness: url.searchParams.get("harness") || "",
          cwd: url.searchParams.get("cwd") || "",
          source_ref: url.searchParams.get("source_ref") || "",
          status: url.searchParams.getAll("status"),
          include_archived: url.searchParams.get("include_archived") === "true",
          include_deleted: url.searchParams.get("include_deleted") === "true",
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        });
        return sendJson(res, result);
      }

      const sessionDetailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === "GET" && sessionDetailMatch) {
        const session = store.getSession(sessionDetailMatch[1] as string);
        if (!session) return sendJson(res, { error: "Not found" }, 404);
        return sendJson(res, session);
      }

      const sessionEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (req.method === "GET" && sessionEventsMatch) {
        const session = store.getSession(sessionEventsMatch[1] as string);
        if (!session) return sendJson(res, { error: "Not found" }, 404);
        const result = store.listSessionEvents({
          session_id: sessionEventsMatch[1] as string,
          type: url.searchParams.get("type") || "",
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          offset: url.searchParams.get("offset")
            ? Number(url.searchParams.get("offset"))
            : undefined,
        });
        return sendJson(res, result);
      }

      if (req.method === "POST" && url.pathname === "/api/sessions/search") {
        const body = await readJson(req, maxBodyBytes);
        const result = store.searchSessions({
          admin: true,
          query: (body.query as string) || "",
          project_key: (body.project_key as string) || "",
          include_archived: body.include_archived === true,
          include_deleted: body.include_deleted === true,
          limit: body.limit ? Number(body.limit) : undefined,
        });
        return sendJson(res, result);
      }

      const sessionActionMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/(checkpoint|pause|end|archive|restore|delete|continue|promote)$/,
      );
      if (req.method === "POST" && sessionActionMatch) {
        const sessionId = sessionActionMatch[1] as string;
        const action = sessionActionMatch[2];
        const body = await readJson(req, maxBodyBytes);
        const session = store.getSession(sessionId);
        if (!session) return sendJson(res, { error: "Not found" }, 404);
        const base = {
          ...body,
          session_id: sessionId,
          agent_id: (body.agent_id as string) || "dashboard",
          admin: true,
        };
        if (action === "checkpoint") return sendJson(res, store.checkpointSession(base));
        if (action === "pause") return sendJson(res, store.pauseSession(base));
        if (action === "end") return sendJson(res, store.endSession(base));
        if (action === "archive") return sendJson(res, store.archiveSession(base));
        if (action === "restore") return sendJson(res, store.restoreSession(base));
        if (action === "delete") return sendJson(res, store.deleteSession(base));
        if (action === "continue") return sendJson(res, store.continueSession(base));
        if (action === "promote") return sendJson(res, store.promoteSessionFact(base));
      }

      if (req.method === "POST" && url.pathname === "/api/recall") {
        const body = await readJson(req, maxBodyBytes);
        const memories = store.searchMemories({
          agent_id: (body.agent_id as string) || DEFAULT_AGENT_ID,
          query: (body.query as string) || "",
          categories: (body.categories as string[]) || [],
          project_key: (body.project_key as string) || "",
          include_private: body.include_private !== false,
          limit: Number(body.limit || 12),
        });
        store.recordRecall(
          memories,
          (body.agent_id as string) || DEFAULT_AGENT_ID,
          (body.query as string) || "",
        );
        return sendJson(res, { memories });
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

function sendFile(
  res: ServerResponse,
  publicDir: string,
  filename: string,
  contentType: string,
): void {
  const filePath = path.join(publicDir, filename);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
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
