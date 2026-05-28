#!/usr/bin/env node
// HTTP bin entrypoint.
//
// Reads env → builds AuthConfig + LibrarianStore → boots the HTTP
// server from `../http/server.ts`. All env parsing + boot-time
// validation lives here so the server module itself stays pure.

import fs from "node:fs";
import path from "node:path";
import {
  createLibrarianStore,
  createSerialScheduler,
  findLegacyScheduleKeys,
  resolveBootCredentials,
  resolveDataDir,
  runBackup,
  runCuratorTick,
  verifyAgentToken,
} from "@librarian/core";
import { bootClassifierWorker } from "../classifier-startup.js";
import { type AuthConfig, AgentTokensError, parseAgentTokenMap, parseCsv } from "../http/auth.js";
import { createHttpServer } from "../http/server.js";
import { logger } from "../logging.js";

const host = process.env.LIBRARIAN_HOST || process.env.LIBRARIAN_DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.LIBRARIAN_PORT || process.env.LIBRARIAN_DASHBOARD_PORT || 3838);
// The localhost no-auth bypass (and the explicit ALLOW_NO_AUTH opt-out) is exactly
// the set of cases that don't require — and shouldn't auto-generate — an admin token.
const allowNoAuth =
  process.env.LIBRARIAN_ALLOW_NO_AUTH === "true" || host === "127.0.0.1" || host === "localhost";

// Resolve the data volume first: the credential files live beside the store and
// must be in place before the store (which needs the key) is built. mkdir up front
// so a fresh install can persist them; a read-only volume falls back gracefully.
const dataDir = resolveDataDir();
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  // Left to the credential resolver (no-secrets fallback) and the store to surface.
}

// D0 credential bootstrap: env wins, then ${dataDir}/{secret.key,admin.token}, then
// generate. The branch that's fatal today (bound beyond localhost with no token) now
// auto-provisions one. A present-but-bad key still fails loud.
let secretKey: Buffer | null;
let adminToken: string;
try {
  const creds = resolveBootCredentials({
    env: process.env,
    dataDir,
    boundBeyondLocalhost: !allowNoAuth,
  });
  secretKey = creds.secretKey;
  adminToken = creds.adminToken ?? "";
  for (const signal of creds.signals) {
    if (signal.source !== "generated") continue;
    if (signal.credential === "secret-key") {
      logger.warn(
        { path: signal.path },
        "Generated a new master key (LIBRARIAN_SECRET_KEY). SAVE THIS KEY — without it, restored secrets cannot be decrypted.",
      );
    } else {
      // The sole sanctioned admin-token log: a fresh install needs it once to enable
      // auth from the dashboard. Never logged again on subsequent boots.
      logger.warn(
        { path: signal.path },
        `Generated a new admin token (LIBRARIAN_ADMIN_TOKEN): ${adminToken}`,
      );
    }
  }
} catch (error) {
  logger.fatal(`Invalid boot credentials: ${(error as Error).message}`);
  process.exit(1);
}

const store = createLibrarianStore({ secretKey, dataDir });
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
const maxBodyBytes = Number(process.env.LIBRARIAN_MAX_BODY_BYTES || 1024 * 1024);

// Reachable only if bound beyond localhost AND credential generation failed (e.g. a
// read-only volume) — we won't run open to the network. Normally D0 generates a token.
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
  // Dashboard-minted agent tokens (A3/A4). Wrapped so a store hiccup is a clean
  // auth miss, never a 500 on the hot auth path.
  verifyDbToken: (token) => {
    try {
      return verifyAgentToken(store, token);
    } catch {
      return null;
    }
  },
};

const server = createHttpServer({ store, auth, maxBodyBytes, secretKey });

// One-line notice if a legacy curator schedule setting is still in settings
// (§12.4 — disable-by-default cadence). Behaviour change is harmless; the
// notice lets operators know to migrate to `curator.interval_minutes`.
{
  const legacyKeys = findLegacyScheduleKeys(store);
  if (legacyKeys.length > 0) {
    logger.warn(
      { keys: legacyKeys },
      "legacy curator schedule keys are present and ignored; configure curator.interval_minutes instead",
    );
  }
}

// Memory-curator scheduler (§14): a serial tick that runs due slices on a cadence.
// The tick self-gates on the admin config (disabled/incomplete → cheap no-op), so
// it's safe to always start. Set LIBRARIAN_CURATOR_TICK_MS=0 to disable (e.g. when
// a separate worker process owns curation). Default hourly; the per-slice
// interval (curator.interval_minutes) is enforced inside the tick.
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

// Classifier worker — store-driven boot. Configure via the
// `/classifier` dashboard cockpit (settings persist in the admin
// store; see `classifier-startup.ts` for the retired
// `LIBRARIAN_CLASSIFIER_*` env contract that the boot path now
// only checks for the env-retired notice). When config is disabled
// or incomplete, boot returns null and mcp-server runs without the
// classifier — `remember` continues through the legacy bridge.
const classifierBoot = bootClassifierWorker({
  store,
  appendEvent: (eventType, payload, options) => {
    store.appendEvent(eventType, payload, options);
  },
  log: (entry) => logger.info(entry),
});

server.listen(port, host, () => {
  curatorScheduler?.start();
  backupScheduler?.start();
  logger.info(
    {
      host,
      port,
      mcp: `http://${host}:${port}/mcp`,
      trpc: `http://${host}:${port}/trpc`,
      classifier: classifierBoot ? "active" : "off",
    },
    "The Librarian MCP service is running",
  );
});

async function shutdown(): Promise<void> {
  curatorScheduler?.stop();
  backupScheduler?.stop();
  // Await the worker drain before closing the DB — an in-flight
  // iteration can still write the verdict via the shared connection.
  await classifierBoot?.worker.stop();
  store.close();
  server.close(() => process.exit(0));
}

function onSignal(): void {
  void shutdown();
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
