#!/usr/bin/env node
// HTTP bin entrypoint.
//
// Reads env → builds AuthConfig + LibrarianStore → boots the HTTP
// server from `../http/server.ts`. All env parsing + boot-time
// validation lives here so the server module itself stays pure.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrarianStore } from "@librarian/core";
import { type AuthConfig, AgentTokensError, parseAgentTokenMap, parseCsv } from "../http/auth.js";
import { createHttpServer } from "../http/server.js";
import { logger } from "../logging.js";

const store = createLibrarianStore();
const host = process.env.LIBRARIAN_HOST || process.env.LIBRARIAN_DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.LIBRARIAN_PORT || process.env.LIBRARIAN_DASHBOARD_PORT || 3838);
const adminToken = process.env.LIBRARIAN_ADMIN_TOKEN || process.env.LIBRARIAN_AUTH_TOKEN || "";
const agentToken = process.env.LIBRARIAN_AGENT_TOKEN || "";

let agentTokenMap: Map<string, string>;
try {
  agentTokenMap = parseAgentTokenMap(process.env.LIBRARIAN_AGENT_TOKENS || "");
} catch (error) {
  if (error instanceof AgentTokensError) {
    logger.fatal(error.message);
    process.exit(1);
  }
  throw error;
}

const allowedOrigins = parseCsv(process.env.LIBRARIAN_ALLOWED_ORIGINS || "");
const allowNoAuth =
  process.env.LIBRARIAN_ALLOW_NO_AUTH === "true" || host === "127.0.0.1" || host === "localhost";
const maxBodyBytes = Number(process.env.LIBRARIAN_MAX_BODY_BYTES || 1024 * 1024);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

if (!adminToken && !allowNoAuth) {
  logger.fatal(
    "Refusing to start without LIBRARIAN_ADMIN_TOKEN or LIBRARIAN_AUTH_TOKEN when bound beyond localhost.",
  );
  process.exit(1);
}

if (adminToken && agentToken && adminToken === agentToken) {
  logger.fatal(
    "Refusing to start because LIBRARIAN_ADMIN_TOKEN and LIBRARIAN_AGENT_TOKEN must be different.",
  );
  process.exit(1);
}

if (adminToken && [...agentTokenMap.values()].some((token) => token === adminToken)) {
  logger.fatal(
    "Refusing to start because LIBRARIAN_ADMIN_TOKEN must not match any LIBRARIAN_AGENT_TOKENS entry.",
  );
  process.exit(1);
}

if (!adminToken) {
  logger.warn(
    "Starting without MCP admin authentication. Use only on localhost or a private development machine.",
  );
}

if (adminToken && !agentToken && !agentTokenMap.size) {
  logger.warn(
    "No agent token is set. Remote agents should use LIBRARIAN_AGENT_TOKEN or per-agent LIBRARIAN_AGENT_TOKENS.",
  );
}

const auth: AuthConfig = {
  adminToken,
  agentToken,
  agentTokenMap,
  allowedOrigins,
  host,
  port,
};

const server = createHttpServer({ store, auth, publicDir, maxBodyBytes });

server.listen(port, host, () => {
  logger.info(
    { host, port, dashboard: `http://${host}:${port}/`, mcp: `http://${host}:${port}/mcp` },
    "The Librarian HTTP service is running",
  );
});

process.on("SIGINT", () => {
  store.close();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  store.close();
  server.close(() => process.exit(0));
});
