#!/usr/bin/env node
// HTTP bin entrypoint.
//
// Reads env → builds AuthConfig + LibrarianStore → boots the HTTP
// server from `../http/server.ts`. All env parsing + boot-time
// validation lives here so the server module itself stays pure.

import fs from "node:fs";
import {
  applyPendingRestore,
  createLibrarianStore,
  createSerialScheduler,
  findLegacyScheduleKeys,
  migrateCuratorAddendum,
  migrateCuratorEnablement,
  migrateCuratorGroomingSchedule,
  resolveBootCredentials,
  resolveDataDir,
  runBackupTick,
  runConsolidatorTick,
  verifyAgentToken,
} from "@librarian/core";
import {
  isConsolidatorEnabled,
  isLegacyConsolidatorEnvSet,
  legacyConsolidatorEnv,
} from "../consolidator-config.js";
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

// Apply a dashboard-staged restore BEFORE the store opens — the vault dir is
// swapped while no store holds it. A failed restore leaves the live vault in place
// (or recovers it) and quarantines the marker for the operator.
{
  const restore = applyPendingRestore(dataDir);
  if (restore.applied) {
    logger.warn(
      { repo: restore.repo },
      "applied a staged restore (vault cloned from backup) on boot",
    );
  } else if (restore.error) {
    logger.error(
      { repo: restore.repo, reason: restore.error },
      "staged restore failed on boot; live vault left in place. The pending marker was " +
        "quarantined to restore.failed.json (not retried) — inspect it and re-stage to retry.",
    );
  }
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

// Grooming schedule migration (spec 045 D-8). Seed the new curator.grooming.*
// schedule pair + moved auto-apply policy keys from their legacy locations ONCE
// (idempotent, no-clobber) so an existing install keeps its exact cadence after
// upgrade. Runs BEFORE the legacy-keys notice below (F22) so a seeded key is
// honoured even while the legacy key remains present.
migrateCuratorGroomingSchedule(store);

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

// Unified curator enablement migration (spec 043 D-E). Seed the new dashboard
// settings from their legacy sources ONCE so an existing install keeps its exact
// enablement after upgrade: curator.grooming.enabled ← curator.enabled,
// curator.intake.enabled ← LIBRARIAN_CONSOLIDATOR. Idempotent + no-clobber — safe
// every boot; the setting is authoritative thereafter. This is also where intake
// gets its env seed (LIBRARIAN_CONSOLIDATOR is only visible at this boundary).
const legacyIntakeEnv = legacyConsolidatorEnv();
migrateCuratorEnablement(store, {
  ...(legacyIntakeEnv !== undefined ? { legacyIntakeEnv } : {}),
});

// Curator addendum migration (spec 044 D-1). Move the legacy
// `curator.prompt_addendum` setting into the committed `.curator/grooming-addendum.md`
// vault file ONCE so an existing install keeps its addendum byte-for-byte, now
// git-versioned, then retire the setting. Idempotent + no-clobber — safe every boot.
// Mirrored at the start of runCuratorTick so any entry point converges.
migrateCuratorAddendum(store);

// Deprecation notice: the LIBRARIAN_CONSOLIDATOR env opt-in is retired to a
// seed-once role (above). It no longer gates intake — the dashboard setting
// (curator.intake.enabled) is authoritative. Warn while the var remains set so
// operators remove it and rely on the setting.
if (isLegacyConsolidatorEnvSet()) {
  logger.warn(
    "LIBRARIAN_CONSOLIDATOR is deprecated and no longer controls intake. Its value was migrated " +
      "to the dashboard setting (curator.intake.enabled) once; the setting is now authoritative. " +
      "Remove the env var — toggle intake from the dashboard instead.",
  );
}

// Memory-curator scheduler: RETIRED (spec 043 D-A). Grooming no longer runs on a
// wall-clock cron. It is triggered instead — by admin `runNow` (trpc/curator.ts) and
// by the post-intake threshold (after an intake sweep crosses
// curator.grooming.trigger_threshold; see grooming-trigger.ts, wired into
// runConsolidatorTick). Due-slice input-hash idempotency is unchanged, so a triggered
// groom only runs the slices whose input actually changed. The intake/backup
// schedulers below are unaffected.

// Scheduled backups: the tick self-gates on the dashboard-managed config
// (`backup.schedule.*`) — disabled → cheap no-op — and runs a backup once the
// configured interval has elapsed. LIBRARIAN_BACKUP_TICK_MS sets the poll cadence
// (default 5 min); 0 disables the scheduler entirely. The legacy
// LIBRARIAN_BACKUP_INTERVAL_MS still enables backups for headless installs that
// never configured a schedule (handled in readBackupConfig).
const backupTickMs = Number(process.env.LIBRARIAN_BACKUP_TICK_MS ?? 5 * 60_000);
const backupScheduler =
  backupTickMs > 0
    ? createSerialScheduler({
        task: async () => {
          const result = await runBackupTick(store);
          if (result?.pushed) {
            logger.info({ repo: result.repo, commit: result.commit }, "pushed a vault backup");
          }
        },
        intervalMs: backupTickMs,
        onError: (error) => logger.error({ err: error }, "scheduled backup tick failed"),
      })
    : null;

// Consolidator scheduler (spec 035 §F5): a serial tick that processes the inbox
// (navigate→judge→apply) on a cadence. Enabled via the dashboard setting
// `curator.intake.enabled` (spec 043 D-E) — the inbox model ships gated (default
// off), reversible. The tick self-gates on the shared LLM config + the markdown
// backend (cheap no-op otherwise), so enabling it without a configured model is
// harmless. Default 5-min cadence; the chokidar watcher (follow-on) makes
// processing near-immediate. LIBRARIAN_CONSOLIDATOR_TICK_MS=0 disables the timer.
const consolidatorEnabled = isConsolidatorEnabled(store);
const consolidatorTickMs = Number(process.env.LIBRARIAN_CONSOLIDATOR_TICK_MS ?? 5 * 60_000);
const consolidatorScheduler =
  consolidatorEnabled && consolidatorTickMs > 0
    ? createSerialScheduler({
        task: () => runConsolidatorTick({ store }),
        intervalMs: consolidatorTickMs,
        onError: (error) => logger.error({ err: error }, "consolidator tick failed"),
      })
    : null;

server.listen(port, host, () => {
  backupScheduler?.start();
  consolidatorScheduler?.start();
  // Boot scan: process anything left in the inbox from a previous run, before
  // the first interval fires (setInterval fires after the interval, not now).
  if (consolidatorEnabled) {
    void runConsolidatorTick({ store }).catch((error) =>
      logger.error({ err: error }, "consolidator boot scan failed"),
    );
  }
  logger.info(
    {
      host,
      port,
      mcp: `http://${host}:${port}/mcp`,
      trpc: `http://${host}:${port}/trpc`,
      consolidator: consolidatorEnabled ? "on" : "off",
    },
    "The Librarian MCP service is running",
  );
});

function shutdown(): void {
  backupScheduler?.stop();
  // Stop the consolidator timer before closing the store — a tick writes through
  // the same store, so it must not fire after store.close() (parity with above).
  consolidatorScheduler?.stop();
  store.close();
  server.close(() => process.exit(0));
}

function onSignal(): void {
  shutdown();
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
