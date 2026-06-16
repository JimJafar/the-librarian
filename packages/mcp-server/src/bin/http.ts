#!/usr/bin/env node
// HTTP bin entrypoint.
//
// Reads env → builds AuthConfig + LibrarianStore → boots the HTTP
// server from `../http/server.ts`. All env parsing + boot-time
// validation lives here so the server module itself stays pure.

import fs from "node:fs";
import {
  applyPendingRestore,
  checkDataDirMigration,
  createLibrarianStore,
  createSerialScheduler,
  findLegacyScheduleKeys,
  isIntakeEnabled,
  isIntakeSweepDue,
  migrateCuratorAddendum,
  migrateJobEnablement,
  migrateGroomingSchedule,
  readGroomingConfig,
  readIntakeInterval,
  readLastIntakeSweepAt,
  resolveBootCredentials,
  resolveDataDir,
  runBackupTick,
  runIntakeTick,
  runScheduledGrooming,
  runTranscriptSweepTick,
  seedPrimer,
  verifyAgentToken,
  writeLastIntakeSweepAt,
} from "@librarian/core";
import type { LibrarianStore } from "@librarian/core";
import {
  type AuthConfig,
  AgentTokensError,
  parseAgentTokenMap,
  parseCsv,
  resolveAllowNoAuth,
} from "../http/auth.js";
import { createHttpServer } from "../http/server.js";
import { isLegacyIntakeEnvSet, legacyIntakeEnvValue } from "../intake-config.js";
import { logger } from "../logging.js";

const host = process.env.LIBRARIAN_HOST || process.env.LIBRARIAN_DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.LIBRARIAN_PORT || process.env.LIBRARIAN_DASHBOARD_PORT || 3838);
// ADR 0008 P1: the admin tRPC API gets its OWN internal listener, off the
// published port. It defaults to loopback (the all-in-one) and an in-container
// port the dashboard reaches over the docker network (compose) — never
// published. Keep it on 127.0.0.1 unless you deliberately run a remote,
// separately-secured dashboard.
const trpcHost = process.env.LIBRARIAN_TRPC_HOST || "127.0.0.1";
const trpcPort = Number(process.env.LIBRARIAN_TRPC_PORT || 3840);

// Resolve the data volume first: the credential files live beside the store and
// must be in place before the store (which needs the key) is built. mkdir up front
// so a fresh install can persist them; a read-only volume falls back gracefully.
const dataDir = resolveDataDir();
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  // Left to the credential resolver (no-secrets fallback) and the store to surface.
}

// D0 credential bootstrap: env wins, then ${dataDir}/secret.key, then generate.
// A present-but-bad key still fails loud. ADR 0008 P3: boot no longer resolves or
// generates an admin token — the internal tRPC listener is trusted (off the
// network), so the token is no longer a network gate.
let secretKey: Buffer | null;
try {
  const creds = resolveBootCredentials({ env: process.env, dataDir });
  secretKey = creds.secretKey;
  for (const signal of creds.signals) {
    if (signal.source !== "generated") continue;
    logger.warn(
      { path: signal.path },
      "Generated a new master key (LIBRARIAN_SECRET_KEY). SAVE THIS KEY — without it, restored secrets cannot be decrypted.",
    );
  }
} catch (error) {
  logger.fatal(`Invalid boot credentials: ${(error as Error).message}`);
  process.exit(1);
}

// The dashboard auth-enable land-grab token (ADR 0008 P3): NOT a network gate —
// it never grants a role (the internal listener is trusted by isolation). It's
// read straight from env ONLY so an operator who sets it can use the dashboard's
// "type the admin token to flip enforcement on" flow (the `auth.enable` compare).
// Unset → "" → that flow is unavailable, which is fine for the default deploy.
const adminToken = process.env.LIBRARIAN_ADMIN_TOKEN || process.env.LIBRARIAN_AUTH_TOKEN || "";

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

// The no-auth bypass (ADR 0008 P3 regression fix). Resolved AFTER the agent
// credentials are parsed because the implicit loopback bypass must NOT fire when
// an agent token is configured — a configured token is enforced regardless of
// host. The explicit LIBRARIAN_ALLOW_NO_AUTH=true opt-out (the all-in-one
// localhost path) still fires even with a token set. See resolveAllowNoAuth.
const allowNoAuth = resolveAllowNoAuth({
  allowNoAuthEnv: process.env.LIBRARIAN_ALLOW_NO_AUTH,
  host,
  agentToken,
  agentTokenMap,
});

// ADR 0008 P3: the admin token is no longer a network gate — there is no longer
// an "admin token required when bound beyond localhost" fatal check, and no
// admin↔agent collision check (a value reused as the enable-flow token can't
// also grant a role on /mcp, so a collision is harmless). The AGENT token is now
// the sole /mcp gate; the relevant misconfig warning is about IT.
if (!allowNoAuth && !agentToken && !agentTokenMap.size) {
  logger.warn(
    "Bound beyond localhost with NO agent token set — /mcp is unreachable until you " +
      "set LIBRARIAN_AGENT_TOKEN or per-agent LIBRARIAN_AGENT_TOKENS (or mint a token in the dashboard).",
  );
}

if (allowNoAuth) {
  logger.warn(
    "Starting with the localhost no-auth bypass — /mcp grants AGENT role without a token. " +
      "Use only on localhost or a private development machine.",
  );
}

const auth: AuthConfig = {
  // No longer a network gate (ADR 0008 P3) — only the dashboard auth-enable
  // land-grab compare reads it (via the tRPC context). Sourced straight from env;
  // boot no longer generates or requires it.
  adminToken,
  agentToken,
  agentTokenMap,
  allowedOrigins,
  // The localhost no-auth bypass grants AGENT on /mcp (never admin, ADR 0008 P3).
  allowNoAuth,
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

// Two listeners (ADR 0008 P1): the PUBLIC one carries the agent surface
// (/mcp, /healthz, /primer.md) on the published host:port; the INTERNAL one
// carries ONLY the admin tRPC API (/trpc/*) on a loopback/docker-network
// host:port that is never published. A /trpc request to the public listener
// 404s — the admin surface is simply not reachable from the network.
const publicServer = createHttpServer({
  store,
  auth,
  maxBodyBytes,
  secretKey,
  surface: "public",
});
const internalServer = createHttpServer({
  store,
  auth,
  maxBodyBytes,
  secretKey,
  surface: "internal",
});

// Grooming schedule migration (spec 045 D-8). Seed the new curator.grooming.*
// schedule pair + moved auto-apply policy keys from their legacy locations ONCE
// (idempotent, no-clobber) so an existing install keeps its exact cadence after
// upgrade. Runs BEFORE the legacy-keys notice below (F22) so a seeded key is
// honoured even while the legacy key remains present.
migrateGroomingSchedule(store);

// One-line notice if a legacy curator schedule setting is still in settings
// (spec 045 F22). The grooming wall-clock schedule is revived under
// curator.grooming.{interval_days,schedule_time}, and migrateGroomingSchedule
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
const legacyIntakeEnv = legacyIntakeEnvValue();
migrateJobEnablement(store, {
  ...(legacyIntakeEnv !== undefined ? { legacyIntakeEnv } : {}),
});

// Primer seed-on-boot (rethink T11, spec §5.2): guarantee vault/primer.md
// exists — absent → the shipped default (or, once, the legacy `awareness.primer`
// settings value), committed through the store. Idempotent + no-clobber, so an
// operator-edited primer is never touched.
seedPrimer(store);

// Curator addendum migration (spec 044 D-1). Move the legacy
// `curator.prompt_addendum` setting into the committed `.curator/grooming-addendum.md`
// vault file ONCE so an existing install keeps its addendum byte-for-byte, now
// git-versioned, then retire the setting. Idempotent + no-clobber — safe every boot.
// Mirrored at the start of runGroomingTick so any entry point converges.
migrateCuratorAddendum(store);

// Data-dir migration checks (rethink T26, spec §10) — warn-only: boot DETECTS
// legacy-shaped state (un-renamed runs file, retired frontmatter fields,
// retired settings keys, archivable artifacts) and logs one line per finding;
// the mutations belong to the CLI's `migrate-data-dir` command. Runs after the
// seed migrations above so already-handled legacy keys don't double-report.
// Fail-soft: a check failure must never block boot.
try {
  for (const finding of checkDataDirMigration({ dataDir })) {
    logger.warn(`data-dir migration: ${finding}`);
  }
} catch (error) {
  logger.warn(
    { err: error },
    "data-dir migration checks failed; skipping (run `migrate-data-dir` to inspect manually)",
  );
}

// Deprecation notice: the LIBRARIAN_CONSOLIDATOR env opt-in is retired to a
// seed-once role (above). It no longer gates intake — the dashboard setting
// (curator.intake.enabled) is authoritative. Warn while the var remains set so
// operators remove it and rely on the setting.
if (isLegacyIntakeEnvSet()) {
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

// Intake (intake) scheduler (spec 035 §F5, plan 046 T7/D-2): a serial poll
// that drains the inbox (navigate→judge→apply). Created UNCONDITIONALLY when the
// poll interval > 0, mirroring backupScheduler — the enable flag
// (`curator.intake.enabled`, spec 043 D-E) is NOT read at boot. Each tick
// self-gates on it inside runIntakeTick (cheap no-op when off), so flipping
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
// the setting, not the timer), then let runIntakeTick self-gate on enabled.
// The last-sweep timestamp is stamped ONLY when a sweep actually ran (result.ran),
// so a disabled job never advances it — re-enabling drains immediately on the next
// poll.
async function runIntakeSweepIfDue(s: LibrarianStore): Promise<void> {
  const now = new Date();
  if (!isIntakeSweepDue(now, readLastIntakeSweepAt(s), readIntakeInterval(s).intervalMinutes)) {
    return;
  }
  const result = await runIntakeTick({ store: s });
  // Stamp only a sweep that actually ran (enabled + configured). A disabled or
  // unconfigured tick leaves the timestamp untouched so it stays "due".
  if (result.ran) writeLastIntakeSweepAt(s, now);
}

const intakeScheduler =
  intakePollMs > 0
    ? createSerialScheduler({
        task: () => runIntakeSweepIfDue(store),
        intervalMs: intakePollMs,
        onError: (error) => logger.error({ err: error }, "intake tick failed"),
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

// Transcript settle-sweep scheduler (spec 2026-06-16-harness-auto-capture, T2):
// a serial poll that scans `<dataDir>/transcripts/` for SETTLED capture buffers
// (idle / explicit-end / size-cap), atomically claims each, makes one extractor
// LLM pass → candidate facts → the existing inbox, then deletes the buffer; an
// orphaned `.processing` is reaped at the start of each tick. Created
// UNCONDITIONALLY when the tick interval > 0, mirroring the intake / grooming /
// backup schedulers — the tick self-gates on `curator.intake.enabled`
// (isIntakeEnabled, the SAME gate T1's endpoint refuses on and the intake tick
// reads), so toggling capture takes effect on the next tick with no restart and
// nothing ever buffers into a dead pipeline.
//
// Tunable env (all LIBRARIAN_*), defaulted in @librarian/core:
//   - LIBRARIAN_TRANSCRIPT_SWEEP_TICK_MS — poll cadence (default 5 min; ≪ the idle
//     window, aligned with the backup tick). 0 disables the sweep timer entirely.
//   - LIBRARIAN_TRANSCRIPT_IDLE_MS — idle settle window (default 30 min).
//   - LIBRARIAN_TRANSCRIPT_MAX_BYTES — size-cap runaway safety valve (default 5 MB).
const transcriptSweepTickMs = Number(process.env.LIBRARIAN_TRANSCRIPT_SWEEP_TICK_MS ?? 5 * 60_000);
const transcriptIdleMs = process.env.LIBRARIAN_TRANSCRIPT_IDLE_MS
  ? Number(process.env.LIBRARIAN_TRANSCRIPT_IDLE_MS)
  : undefined;
const transcriptMaxBytes = process.env.LIBRARIAN_TRANSCRIPT_MAX_BYTES
  ? Number(process.env.LIBRARIAN_TRANSCRIPT_MAX_BYTES)
  : undefined;

async function runTranscriptSweep(s: LibrarianStore): Promise<void> {
  const summary = await runTranscriptSweepTick({
    store: s,
    ...(transcriptIdleMs !== undefined ? { idleMs: transcriptIdleMs } : {}),
    ...(transcriptMaxBytes !== undefined ? { maxBytes: transcriptMaxBytes } : {}),
    // Surface a swallowed per-buffer failure to the server log (the worker stays
    // fail-soft — it never rejects, so this is observability only).
    warn: (info, msg) => logger.warn(info, msg),
  });
  if (summary.extracted > 0 || summary.reaped > 0) {
    logger.info(
      { extracted: summary.extracted, facts: summary.facts, reaped: summary.reaped },
      "transcript settle-sweep extracted capture buffers to the inbox",
    );
  }
}

const transcriptSweepScheduler =
  transcriptSweepTickMs > 0
    ? createSerialScheduler({
        task: () => runTranscriptSweep(store),
        intervalMs: transcriptSweepTickMs,
        onError: (error) => logger.error({ err: error }, "transcript settle-sweep tick failed"),
      })
    : null;

// The internal (admin tRPC) listener. Bound first so the admin surface is up
// independently of the public one; it never starts the schedulers (the public
// boot callback owns those).
internalServer.listen(trpcPort, trpcHost, () => {
  logger.info(
    { host: trpcHost, port: trpcPort, trpc: `http://${trpcHost}:${trpcPort}/trpc` },
    "The Librarian admin tRPC API is listening (internal — not published)",
  );
});

publicServer.listen(port, host, () => {
  backupScheduler?.start();
  intakeScheduler?.start();
  groomingScheduler?.start();
  transcriptSweepScheduler?.start();
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
      logger.error({ err: error }, "intake boot scan failed"),
    );
  }
  if (groomingScheduler) {
    void runScheduledGrooming({ store }).catch((error) =>
      logger.error({ err: error }, "grooming boot scan failed"),
    );
  }
  // Boot scan for the settle-sweep: drain any capture buffers a previous run left
  // settled (e.g. a crash before the first tick), and reap orphaned `.processing`
  // claims. Gated on the scheduler being live, like the intake/grooming boot scans;
  // a cheap no-op when capture is disabled or no buffer has settled.
  if (transcriptSweepScheduler) {
    void runTranscriptSweep(store).catch((error) =>
      logger.error({ err: error }, "transcript settle-sweep boot scan failed"),
    );
  }
  // Honest banner (plan 046 T7/D-6): report each job's LIVE enable state read at
  // log time (not a static boot value), and word it as the two distinct jobs.
  logger.info(
    {
      host,
      port,
      mcp: `http://${host}:${port}/mcp`,
      // tRPC now lives on the internal listener (ADR 0008 P1), NOT the public
      // port — report where it actually is so a misconfig is visible at boot.
      trpc: `http://${trpcHost}:${trpcPort}/trpc`,
      intake: isIntakeEnabled(store) ? "on" : "off",
      grooming: readGroomingConfig(store).enabled ? "on" : "off",
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
  transcriptSweepScheduler?.stop();
  store.close();
  // Close BOTH listeners (ADR 0008 P1) so neither leaks on SIGTERM/SIGINT; only
  // exit once both have released their sockets.
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(0);
  };
  publicServer.close(done);
  internalServer.close(done);
}

function onSignal(): void {
  shutdown();
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
