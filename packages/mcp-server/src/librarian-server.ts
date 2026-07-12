// The Librarian server composition root (spec 060 T2, ADR 0011 seam S1).
//
// `createLibrarianServer(options)` owns what `bin/http.ts` used to boot
// imperatively: store construction, the AuthConfig, both HTTP listeners (the
// public agent surface on :3838 and the internal admin tRPC API on :3840, ADR
// 0008 P1), the boot migrations, the four curation schedulers, and shutdown. It
// returns a handle — `{ start, stop, store, internals }` — so the same server
// the bin runs can be assembled from tests without spawning a subprocess, and so
// a downstream integrator (the Teams edition, ADR 0011) can compose the same
// factory. The bin reduces to env parsing + one factory call.
//
// The factory takes ENV-DERIVED options only: the bin does all `process.env`
// reading, the pre-store fatal validation (credentials, agent-token map), and
// the staged-restore step, then hands resolved values here. This module never
// reads `process.env`, so the composition is drivable from any caller.

import {
  type LibrarianStore,
  type SerialScheduler,
  checkDataDirMigration,
  createLibrarianStore,
  createSerialScheduler,
  findLegacyScheduleKeys,
  isIntakeEnabled,
  isIntakeSweepDue,
  migrateCuratorAddendum,
  migrateGroomingSchedule,
  migrateJobEnablement,
  readGroomingConfig,
  readIntakeInterval,
  readLastIntakeSweepAt,
  runBackupTick,
  runIntakeTick,
  runScheduledGrooming,
  runTranscriptSweepTick,
  seedPrimer,
  verifyAgentToken,
  writeLastIntakeSweepAt,
} from "@librarian/core";
import type { AuthConfig } from "./http/auth.js";
import { createHttpServer } from "./http/server.js";
import { logger } from "./logging.js";
import { type LibrarianPlugin, assertUniquePluginNames, buildToolRegistry } from "./plugin.js";

/**
 * Env-derived options for {@link createLibrarianServer}. The bin resolves every
 * one of these from `process.env` (and the credential / restore steps) before
 * calling the factory — see `bin/http.ts`. The `plugins` slot carries build-time
 * extensions (ADR 0011); its `trpcRouters` / `routes` / provider seams arrive in
 * later 060 tasks (T4–T6).
 */
export interface LibrarianServerOptions {
  /** Resolved data volume (`resolveDataDir`); the store + migration checks read it. */
  dataDir: string;
  /** Master key (env → `${dataDir}/secret.key` → generated), threaded to the store + tRPC auth router. */
  secretKey: Buffer | null;
  /** Published agent-surface bind (LIBRARIAN_HOST:PORT). */
  host: string;
  port: number;
  /** Internal admin tRPC bind (LIBRARIAN_TRPC_HOST:PORT), never published (ADR 0008 P1). */
  trpcHost: string;
  trpcPort: number;
  /** Dashboard auth-enable land-grab token — NOT a network gate (ADR 0008 P3); "" when unset. */
  adminToken: string;
  /** The `/mcp` agent-token gate (ADR 0008 P3); "" when unset. */
  agentToken: string;
  /** Per-agent token map (LIBRARIAN_AGENT_TOKENS), already parsed. */
  agentTokenMap: Map<string, string>;
  /** Browser-origin allow-list (LIBRARIAN_ALLOWED_ORIGINS), already split. */
  allowedOrigins: string[];
  /** The localhost no-auth bypass (`resolveAllowNoAuth`); grants AGENT on `/mcp`, never admin. */
  allowNoAuth: boolean;
  /** Generic request-body cap (/mcp, /transcript). */
  maxBodyBytes: number;
  /** Backup poll cadence in ms; 0 disables the scheduler entirely. */
  backupTickMs: number;
  /** Intake poll floor in ms; 0 disables the scheduler entirely. */
  intakePollMs: number;
  /** Grooming poll cadence in ms; 0 disables the scheduler entirely. */
  groomingPollMs: number;
  /** Transcript settle-sweep poll cadence in ms; 0 disables the scheduler entirely. */
  transcriptSweepTickMs: number;
  /** Transcript idle settle window in ms; absent → the core default. */
  transcriptIdleMs?: number;
  /** Transcript size-cap safety valve in bytes; absent → the core default. */
  transcriptMaxBytes?: number;
  /** Raw legacy `LIBRARIAN_CONSOLIDATOR` value (seed + deprecation notice); absent → unset. */
  legacyIntakeEnv?: string;
  /**
   * Build-time plugins (ADR 0011 seam S1, spec 060). Default `[]`. Each plugin's
   * MCP `tools` join the registry the /mcp handler dispatches through — role-filtered
   * and dispatched exactly like core tools (SC 4). A duplicate plugin `name`, or a
   * plugin tool whose `name` collides with a core tool or another plugin's tool, is a
   * construction-time throw naming the offender (SC 7). With no plugins the tool
   * surface is byte-identical to today. The `trpcRouters` / `routes` / provider slots
   * arrive in spec 060 T4–T6.
   */
  plugins?: readonly LibrarianPlugin[];
}

/**
 * Non-API test/observability seam exposed on the server handle. Marked here, and
 * NOT re-exported through the package's public entrypoint (`index.ts`): it may
 * change without notice, and nothing outside the repo's own tests should depend
 * on it.
 *
 * @internal
 */
export interface LibrarianServerInternals {
  /** The live curation schedulers (backup/intake/grooming/transcript order), nulls excluded. */
  readonly schedulers: readonly SerialScheduler[];
}

/**
 * The server handle {@link createLibrarianServer} returns. `start()` binds both
 * listeners (and, once the public one is accepting, starts the schedulers);
 * `stop()` runs the load-bearing shutdown order and resolves when both listeners
 * have released their sockets. `store` is the constructed store; `internals` is a
 * non-API seam (see {@link LibrarianServerInternals}).
 */
export interface LibrarianServer {
  start(): void;
  stop(): Promise<void>;
  readonly store: LibrarianStore;
  /** @internal Non-API — may change without notice; not part of the published surface. */
  readonly internals: LibrarianServerInternals;
}

export function createLibrarianServer(options: LibrarianServerOptions): LibrarianServer {
  // Plugin registration (spec 060 T3, ADR 0011). Validate names + merge tools BEFORE
  // opening the store, so a colliding plugin config fails construction loudly, with
  // no side effects. buildToolRegistry throws (naming the offending plugin) on any
  // tool-name collision; assertUniquePluginNames throws on a duplicate plugin name.
  const plugins = options.plugins ?? [];
  assertUniquePluginNames(plugins);
  const toolRegistry = buildToolRegistry(plugins);

  const {
    dataDir,
    secretKey,
    host,
    port,
    trpcHost,
    trpcPort,
    adminToken,
    agentToken,
    agentTokenMap,
    allowedOrigins,
    allowNoAuth,
    maxBodyBytes,
    backupTickMs,
    intakePollMs,
    groomingPollMs,
    transcriptSweepTickMs,
    transcriptIdleMs,
    transcriptMaxBytes,
    legacyIntakeEnv,
  } = options;

  const store = createLibrarianStore({ secretKey, dataDir });

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
    toolRegistry,
  });
  const internalServer = createHttpServer({
    store,
    auth,
    maxBodyBytes,
    secretKey,
    surface: "internal",
    toolRegistry,
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
  // operators remove it and rely on the setting. `legacyIntakeEnv !== undefined`
  // mirrors the retired `isLegacyIntakeEnvSet()` (env present to any value).
  if (legacyIntakeEnv !== undefined) {
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

  // The load-bearing scheduler set: backup/intake/grooming/transcript order, with
  // the disabled (interval 0 → null) ones excluded. start()/stop() iterate this,
  // preserving today's `?.start()` / `?.stop()` semantics (a null scheduler is a
  // no-op) exactly (ADR 0008 shutdown parity, spec 060 SC 3).
  const schedulers = [
    backupScheduler,
    intakeScheduler,
    groomingScheduler,
    transcriptSweepScheduler,
  ].filter((scheduler): scheduler is SerialScheduler => scheduler !== null);

  const onInternalListening = (): void => {
    logger.info(
      { host: trpcHost, port: trpcPort, trpc: `http://${trpcHost}:${trpcPort}/trpc` },
      "The Librarian admin tRPC API is listening (internal — not published)",
    );
  };

  const onPublicListening = (): void => {
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
    //
    // Run it THROUGH the scheduler's in-flight guard (runNow), NOT fire-and-forget:
    // the boot scan can overrun the tick interval, and if a scheduled tick ran
    // concurrently the reaper could mis-recover this scan's own live `.processing`
    // claim and double-extract. runNow shares the same guard the ticks use, so the
    // boot scan and any tick can never overlap.
    if (transcriptSweepScheduler) {
      void transcriptSweepScheduler
        .runNow()
        .catch((error) => logger.error({ err: error }, "transcript settle-sweep boot scan failed"));
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
  };

  const runtime: ServerRuntime = {
    schedulers,
    store,
    publicServer,
    internalServer,
    publicBind: { port, host },
    internalBind: { port: trpcPort, host: trpcHost },
    onInternalListening,
    onPublicListening,
  };

  return {
    start: () => startRuntime(runtime),
    stop: () => stopRuntime(runtime),
    store,
    internals: { schedulers },
  };
}

/**
 * The minimal `node:http.Server` view {@link startRuntime}/{@link stopRuntime}
 * drive: bind a listener (with a listening callback) and close it. `http.Server`
 * satisfies this structurally, and a test fake need only implement these two.
 */
interface HttpListener {
  listen(port: number, host: string, onListening: () => void): void;
  close(callback: (err?: Error) => void): void;
}

/**
 * The assembled, ordered parts the server lifecycle operates on. Exported (but
 * NOT via the package entrypoint) so the spec 060 SC 3 tests can drive
 * start/stop with instrumented fakes and assert the load-bearing order in both
 * directions — the SAME functions the factory's handle delegates to, so a
 * reordering regression breaks the tests.
 *
 * @internal
 */
export interface ServerRuntime {
  /** Live schedulers in start/stop order (backup/intake/grooming/transcript), nulls excluded. */
  readonly schedulers: readonly SerialScheduler[];
  /** The store whose `close()` must run AFTER the schedulers stop and BEFORE the listeners close. */
  readonly store: Pick<LibrarianStore, "close">;
  readonly publicServer: HttpListener;
  readonly internalServer: HttpListener;
  readonly publicBind: { readonly port: number; readonly host: string };
  readonly internalBind: { readonly port: number; readonly host: string };
  /** Logged once the internal listener is accepting. */
  readonly onInternalListening: () => void;
  /** Boot scans + banner, run AFTER the schedulers start, once the public listener is accepting. */
  readonly onPublicListening: () => void;
}

/**
 * Bind both listeners and, once the PUBLIC one is accepting, start every
 * scheduler exactly once and run the boot scans + banner — preserving today's
 * order (`bin/http.ts`): the internal listener binds first (so the admin surface
 * is up independently), then the public listener's callback starts the
 * schedulers BEFORE the boot scans, so no tick can fire before the listener is
 * accepting (spec 060 SC 3).
 *
 * @internal
 */
export function startRuntime(runtime: ServerRuntime): void {
  // The internal (admin tRPC) listener. Bound first so the admin surface is up
  // independently of the public one; it never starts the schedulers (the public
  // boot callback owns those).
  runtime.internalServer.listen(
    runtime.internalBind.port,
    runtime.internalBind.host,
    runtime.onInternalListening,
  );

  runtime.publicServer.listen(runtime.publicBind.port, runtime.publicBind.host, () => {
    for (const scheduler of runtime.schedulers) scheduler.start();
    runtime.onPublicListening();
  });
}

/**
 * The load-bearing shutdown order (spec 060 SC 3, `bin/http.ts` parity): stop
 * every scheduler timer FIRST, THEN `store.close()`, THEN close both listeners —
 * a tick writes through the same store, so no tick must fire after the store is
 * closed. Resolves once BOTH listeners have released their sockets so neither
 * leaks on SIGTERM/SIGINT; the caller (the bin) exits after the promise settles.
 *
 * @internal
 */
export function stopRuntime(runtime: ServerRuntime): Promise<void> {
  // Stop the job timers before closing the store — a tick writes through the same
  // store, so neither must fire after store.close().
  for (const scheduler of runtime.schedulers) scheduler.stop();
  runtime.store.close();
  // Close BOTH listeners (ADR 0008 P1) so neither leaks; resolve once both have
  // released their sockets.
  return new Promise((resolve) => {
    let pending = 2;
    const done = (): void => {
      if (--pending === 0) resolve();
    };
    runtime.publicServer.close(done);
    runtime.internalServer.close(done);
  });
}
