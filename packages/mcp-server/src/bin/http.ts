#!/usr/bin/env node
// HTTP bin entrypoint.
//
// Reads env → builds AuthConfig + LibrarianStore → boots the HTTP
// server from `../http/server.ts`. All env parsing + boot-time
// validation lives here so the server module itself stays pure.

import path from "node:path";
import {
  createLibrarianStore,
  createSerialScheduler,
  resolveOptionalSecretKey,
  runBackup,
  runCuratorTick,
} from "@librarian/core";
import { type AuthConfig, AgentTokensError, parseAgentTokenMap, parseCsv } from "../http/auth.js";
import { createHttpServer } from "../http/server.js";
import { logger } from "../logging.js";

// LIBRARIAN_SECRET_KEY (optional) unlocks encrypted admin settings (the curator's
// LLM token). Absent → store runs without secret support; present-but-bad → fail loud.
let secretKey: Buffer | null;
try {
  secretKey = resolveOptionalSecretKey(process.env.LIBRARIAN_SECRET_KEY);
} catch (error) {
  logger.fatal(`Invalid LIBRARIAN_SECRET_KEY: ${(error as Error).message}`);
  process.exit(1);
}
const store = createLibrarianStore({ secretKey });
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

const server = createHttpServer({ store, auth, maxBodyBytes });

// Memory-curator scheduler (§14): a serial tick that runs due slices on a cadence.
// The tick self-gates on the admin config (disabled/incomplete → cheap no-op), so
// it's safe to always start. Set LIBRARIAN_CURATOR_TICK_MS=0 to disable (e.g. when
// a separate worker process owns curation). Default hourly; the per-slice schedule
// (every N days at HH:MM) is enforced inside the tick.
const curatorTickMs = Number(process.env.LIBRARIAN_CURATOR_TICK_MS ?? 60 * 60_000);
const curatorScheduler =
  curatorTickMs > 0
    ? createSerialScheduler({
        task: () => runCuratorTick({ store }),
        intervalMs: curatorTickMs,
        onError: (error) => logger.error({ err: error }, "curator tick failed"),
      })
    : null;

// Scheduled backups (opt-in): set LIBRARIAN_BACKUP_INTERVAL_MS > 0 to enable. Each
// tick writes a local bundle and, if cloud sync is configured, uploads it.
const backupIntervalMs = Number(process.env.LIBRARIAN_BACKUP_INTERVAL_MS ?? 0);
const backupDir = process.env.LIBRARIAN_BACKUP_DIR || path.join(store.dataDir, "backups");
const backupScheduler =
  backupIntervalMs > 0
    ? createSerialScheduler({
        task: () => runBackup(store, { destDir: backupDir }),
        intervalMs: backupIntervalMs,
        onError: (error) => logger.error({ err: error }, "scheduled backup failed"),
      })
    : null;

server.listen(port, host, () => {
  curatorScheduler?.start();
  backupScheduler?.start();
  logger.info(
    { host, port, mcp: `http://${host}:${port}/mcp`, trpc: `http://${host}:${port}/trpc` },
    "The Librarian MCP service is running",
  );
});

function shutdown(): void {
  curatorScheduler?.stop();
  backupScheduler?.stop();
  store.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
