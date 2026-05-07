#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { LibrarianStore } from "./store.js";
import { DEFAULT_AGENT_ID } from "./constants.js";
import { handleMcpPayload } from "./mcp.js";

const store = new LibrarianStore();
const host =
  process.env.LIBRARIAN_HOST ||
  process.env.LIBRARIAN_DASHBOARD_HOST ||
  "0.0.0.0";
const port = Number(
  process.env.LIBRARIAN_PORT || process.env.LIBRARIAN_DASHBOARD_PORT || 3838,
);
const adminToken =
  process.env.LIBRARIAN_ADMIN_TOKEN || process.env.LIBRARIAN_AUTH_TOKEN || "";
const agentToken = process.env.LIBRARIAN_AGENT_TOKEN || "";
const agentTokenMap = parseAgentTokenMap(
  process.env.LIBRARIAN_AGENT_TOKENS || "",
);
const allowedOrigins = parseCsv(process.env.LIBRARIAN_ALLOWED_ORIGINS || "");
const allowNoAuth =
  process.env.LIBRARIAN_ALLOW_NO_AUTH === "true" ||
  host === "0.0.0.0" ||
  host === "localhost";
const maxBodyBytes = Number(
  process.env.LIBRARIAN_MAX_BODY_BYTES || 1024 * 1024,
);
const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

if (!adminToken && !allowNoAuth) {
  console.error(
    "Refusing to start without LIBRARIAN_ADMIN_TOKEN or LIBRARIAN_AUTH_TOKEN when bound beyond localhost.",
  );
  process.exit(1);
}

if (adminToken && agentToken && adminToken === agentToken) {
  console.error(
    "Refusing to start because LIBRARIAN_ADMIN_TOKEN and LIBRARIAN_AGENT_TOKEN must be different.",
  );
  process.exit(1);
}

if (
  adminToken &&
  [...agentTokenMap.values()].some((token) => token === adminToken)
) {
  console.error(
    "Refusing to start because LIBRARIAN_ADMIN_TOKEN must not match any LIBRARIAN_AGENT_TOKENS entry.",
  );
  process.exit(1);
}

if (!adminToken) {
  console.error(
    "Warning: starting without MCP admin authentication. Use only on localhost or a private development machine.",
  );
}

if (adminToken && !agentToken && !agentTokenMap.size) {
  console.error(
    "Warning: no agent token is set. Remote agents should use LIBRARIAN_AGENT_TOKEN or per-agent LIBRARIAN_AGENT_TOKENS.",
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, {
        status: "ok",
        dashboard_auth: "disabled",
        mcp_auth: adminToken ? "enabled" : "disabled",
        auth: adminToken ? "enabled" : "disabled",
        agent_auth: agentToken || agentTokenMap.size ? "enabled" : "disabled",
      });
    }

    if (!isAllowedOrigin(req))
      return sendJson(res, { error: "Origin not allowed" }, 403);

    if (url.pathname === "/mcp") {
      const auth = authenticateMcp(req);
      if (!auth) return sendUnauthorized(res);
      if (req.method === "GET") {
        return sendJson(res, {
          status: "ok",
          transport: "json-rpc-http",
          message: "POST JSON-RPC MCP messages to this endpoint.",
        });
      }
      if (req.method !== "POST")
        return sendJson(res, { error: "Method not allowed" }, 405);
      const payload = await readJson(req);
      const response = await handleMcpPayload(store, payload, {
        role: auth.role,
        agentId: auth.agentId,
      });
      if (response === null) return sendEmpty(res);
      return sendJson(res, response);
    }

    if (req.method === "GET" && url.pathname === "/") {
      return sendFile(res, "index.html", "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/styles.css") {
      return sendFile(res, "styles.css", "text/css; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      return sendFile(res, "app.js", "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, {
        memories: store.listMemories({}),
        events: store.readEvents().slice(-200).reverse(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/memories") {
      const body = await readJson(req);
      const result = store.createMemory(body);
      return sendJson(res, result);
    }

    const updateMatch = url.pathname.match(
      /^\/api\/memories\/([^/]+)\/update$/,
    );
    if (req.method === "POST" && updateMatch) {
      const body = await readJson(req);
      return sendJson(
        res,
        store.updateMemory(
          updateMatch[1],
          body.patch || body,
          body.agent_id || "dashboard",
        ),
      );
    }

    const deleteMatch = url.pathname.match(
      /^\/api\/memories\/([^/]+)\/delete$/,
    );
    if (req.method === "POST" && deleteMatch) {
      const body = await readJson(req);
      return sendJson(
        res,
        store.deleteMemory(deleteMatch[1], body.agent_id || "dashboard"),
      );
    }

    const approveMatch = url.pathname.match(
      /^\/api\/proposals\/([^/]+)\/approve$/,
    );
    if (req.method === "POST" && approveMatch) {
      const body = await readJson(req);
      return sendJson(
        res,
        store.approveProposal(
          approveMatch[1],
          "approve",
          body.patch || {},
          body.agent_id || "dashboard",
        ),
      );
    }

    const rejectMatch = url.pathname.match(
      /^\/api\/proposals\/([^/]+)\/reject$/,
    );
    if (req.method === "POST" && rejectMatch) {
      const body = await readJson(req);
      return sendJson(
        res,
        store.approveProposal(
          rejectMatch[1],
          "reject",
          {},
          body.agent_id || "dashboard",
        ),
      );
    }

    if (req.method === "POST" && url.pathname === "/api/recall") {
      const body = await readJson(req);
      const memories = store.searchMemories({
        agent_id: body.agent_id || DEFAULT_AGENT_ID,
        query: body.query || "",
        categories: body.categories || [],
        project_key: body.project_key || "",
        include_private: body.include_private !== false,
        limit: Number(body.limit || 12),
      });
      store.recordRecall(
        memories,
        body.agent_id || DEFAULT_AGENT_ID,
        body.query || "",
      );
      return sendJson(res, { memories });
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message }, error.statusCode || 500);
  }
});

server.listen(port, host, () => {
  console.error(
    `The Librarian HTTP service is running at http://${host}:${port}`,
  );
  console.error(`Dashboard: http://${host}:${port}/`);
  console.error(`MCP endpoint: http://${host}:${port}/mcp`);
});

process.on("SIGINT", () => {
  store.close();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  store.close();
  server.close(() => process.exit(0));
});

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filename, contentType) {
  const filePath = path.join(publicDir, filename);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
}

function sendEmpty(res) {
  res.writeHead(202, {
    "cache-control": "no-store",
  });
  res.end();
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": "Bearer",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

async function readJson(req) {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError("Request body too large", 413);
    body += chunk;
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw httpError(`Invalid JSON body: ${error.message}`, 400);
  }
}

function authenticateMcp(req) {
  if (!adminToken) return { role: "admin" };
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length);
    for (const [agentId, mappedToken] of agentTokenMap) {
      if (timingSafeEqual(token, mappedToken))
        return { role: "agent", agentId };
    }
    if (agentToken && timingSafeEqual(token, agentToken))
      return { role: "agent" };
    if (timingSafeEqual(token, adminToken)) return { role: "admin" };
    return null;
  }
  return null;
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  try {
    const originUrl = new URL(origin);
    const hostHeader = req.headers.host || `${host}:${port}`;
    return originUrl.origin === `http://${hostHeader}`;
  } catch {
    return false;
  }
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return cryptoTimingSafeEqual(left, right);
}

function parseCsv(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAgentTokenMap(value) {
  const entries = parseCsv(value);
  const map = new Map();
  const seenTokens = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      console.error(
        "Invalid LIBRARIAN_AGENT_TOKENS entry. Use agent_id:token pairs separated by commas.",
      );
      process.exit(1);
    }
    const agentId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (map.has(agentId)) {
      console.error(
        `Duplicate LIBRARIAN_AGENT_TOKENS entry for agent ${agentId}.`,
      );
      process.exit(1);
    }
    if (seenTokens.has(token)) {
      console.error(
        `Duplicate LIBRARIAN_AGENT_TOKENS token for agents ${seenTokens.get(token)} and ${agentId}.`,
      );
      process.exit(1);
    }
    map.set(agentId, token);
    seenTokens.set(token, agentId);
  }
  return map;
}
