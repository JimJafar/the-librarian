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
  isIntakeEnabled,
  isIntakeSweepDue,
  migrateCuratorAddendum,
  migrateCuratorEnablement,
  migrateCuratorGroomingSchedule,
  readCuratorConfig,
  readIntakeInterval,
  readLastIntakeSweepAt,
  resolveBootCredentials,
  resolveDataDir,
  runBackupTick,
  runConsolidatorTick,
  runScheduledGrooming,
  verifyAgentToken,
  writeLastIntakeSweepAt,
} from "@librarian/core";
import type { LibrarianStore } from "@librarian/core";
import { isLegacyConsolidatorEnvSet, legacyConsolidatorEnv } from "../consolidator-config.js";
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
// (spec 045 F22). The grooming wall-clock schedule is revived under
// curator.grooming.{interval_days,schedule_time}, and migrateCuratorGroomingSchedule
// (run just above) has already seeded those from the legacy curator.schedule.* keys
// when present. So the legacy keys are no longer "ignored" — their values were
// migrated. The notice now just flags that the old keys linger and can be deleted;
// the live schedule is the curator.grooming.* pair (retired key
// curator.interval_minutes is no longer referenced here).
{
  const legacyKeys = findLegacyScheduleKeys(store);
  if (legacyKeys.length > 0) {
    logger.warn(
      { keys: legacyKeys },
      "legacy curator schedule keys are present; their values were migrated to " +
        "curator.grooming.{interval_days,schedule_time} (the live grooming schedule). " +
        "You can delete the legacy keys.",
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

// Intake (consolidator) scheduler (spec 035 §F5, plan 046 T7/D-2): a serial poll
// that drains the inbox (navigate→judge→apply). Created UNCONDITIONALLY when the
// poll interval > 0, mirroring backupScheduler — the enable flag
// (`curator.intake.enabled`, spec 043 D-E) is NOT read at boot. Each tick
// self-gates on it inside runConsolidatorTick (cheap no-op when off), so flipping
// the dashboard toggle takes effect on the NEXT poll with no restart (D-2).
//
// Runtime-effective cadence (Success Criterion #1): the timer fires on a fixed
// short poll floor (LIBRARIAN_CONSOLIDATOR_TICK_MS, default 60s) and each poll
// only sweeps once `curator.intake.interval_minutes` (readIntakeInterval) have
// elapsed since the last sweep (isIntakeSweepDue against the stored
// curator.intake.last_sweep_at). So editing interval_minutes from the dashboard
// changes the effective sweep gap on the next poll — no restart, no boot-fixed
// timer interval. The poll floor is the resolution: the effective gap is
// max(interval_minutes, poll-floor). LIBRARIAN_CONSOLIDATOR_TICK_MS=0 disables
// the timer entirely (e.g. an install that drives intake only via run-now).
const intakePollMs = Number(process.env.LIBRARIAN_CONSOLIDATOR_TICK_MS ?? 60_000);

// One poll: sweep only when the configured interval has elapsed (so the cadence is
// the setting, not the timer), then let runConsolidatorTick self-gate on enabled.
// The last-sweep timestamp is stamped ONLY when a sweep actually ran (result.ran),
// so a disabled job never advances it — re-enabling drains immediately on the next
// poll.
async function runIntakeSweepIfDue(s: LibrarianStore): Promise<void> {
  const now = new Date();
  if (!isIntakeSweepDue(now, readLastIntakeSweepAt(s), readIntakeInterval(s).intervalMinutes)) {
    return;
  }
  const result = await runConsolidatorTick({ store: s });
  // Stamp only a sweep that actually ran (enabled + configured). A disabled or
  // unconfigured tick leaves the timestamp untouched so it stays "due".
  if (result.ran) writeLastIntakeSweepAt(s, now);
}

const intakeScheduler =
  intakePollMs > 0
    ? createSerialScheduler({
        task: () => runIntakeSweepIfDue(store),
        intervalMs: intakePollMs,
        onError: (error) => logger.error({ err: error }, "consolidator tick failed"),
      })
    : null;

// Grooming scheduler (spec 045 D-3, plan 046 T7/D-2): a serial poll that runs a
// scheduled grooming pass when the wall-clock schedule (curator.grooming.{interval_days,
// schedule_time}) is due. Created UNCONDITIONALLY when the poll interval > 0, like
// the intake + backup schedulers. runScheduledGrooming self-gates on
// `curator.grooming.enabled`, checks isScheduleDue against the last scheduled run,
// and stamps curator.grooming.last_scheduled_run_at — so toggling grooming on/off or
// editing its schedule takes effect on the next poll with no restart. The poll
// cadence is just the schedule's RESOLUTION (default ~15 min); the schedule itself
// decides when a pass fires. LIBRARIAN_GROOMING_TICK_MS=0 disables the timer.
const groomingPollMs = Number(process.env.LIBRARIAN_GROOMING_TICK_MS ?? 15 * 60_000);
const groomingScheduler =
  groomingPollMs > 0
    ? createSerialScheduler({
        task: () => runScheduledGrooming({ store }),
        intervalMs: groomingPollMs,
        onError: (error) => logger.error({ err: error }, "grooming tick failed"),
      })
    : null;

server.listen(port, host, () => {
  backupScheduler?.start();
  intakeScheduler?.start();
  groomingScheduler?.start();
  // Boot scan (plan 046 T7): kick each job once at boot, before the first poll
  // fires (setInterval fires after the interval, not now). The intake sweep drains
  // an inbox backlog left from a previous run; the grooming due-check runs a pass
  // if the nightly schedule is already overdue. Each is a cheap no-op when its job
  // is disabled / not due.
  //
  // The boot scan is GATED on its scheduler being live (the `*_TICK_MS=0` disable):
  // disabling a job's timer means "no AUTOMATIC curation for this job at all" — not
  // "no timer, but still groom/sweep once on every restart". Without this, a server
  // with the grooming timer off would still groom the whole corpus at each boot, a
  // surprising hole (and the source of non-deterministic boot-time grooming in the
  // integration tests, which pin the ticks off). Run-now + the tRPC dry-run /
  // re-evaluate paths bypass the schedulers and are unaffected.
  if (intakeScheduler) {
    void runIntakeSweepIfDue(store).catch((error) =>
      logger.error({ err: error }, "consolidator boot scan failed"),
    );
  }
  if (groomingScheduler) {
    void runScheduledGrooming({ store }).catch((error) =>
      logger.error({ err: error }, "grooming boot scan failed"),
    );
  }
  // Honest banner (plan 046 T7/D-6): report each job's LIVE enable state read at
  // log time (not a static boot value), and word it as the two distinct jobs.
  logger.info(
    {
      host,
      port,
      mcp: `http://${host}:${port}/mcp`,
      trpc: `http://${host}:${port}/trpc`,
      intake: isIntakeEnabled(store) ? "on" : "off",
      grooming: readCuratorConfig(store).enabled ? "on" : "off",
    },
    "The Librarian MCP service is running",
  );
});

function shutdown(): void {
  backupScheduler?.stop();
  // Stop the job timers before closing the store — a tick writes through the same
  // store, so neither must fire after store.close() (parity with backupScheduler).
  intakeScheduler?.stop();
  groomingScheduler?.stop();
  store.close();
  server.close(() => process.exit(0));
}

function onSignal(): void {
  shutdown();
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
