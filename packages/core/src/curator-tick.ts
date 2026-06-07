// Curator tick (spec §12 + §14) — the config-driven entrypoint for grooming.
// Grooming is triggered, not scheduled (the wall-clock cron was retired in spec
// 043 D-A): this runs from the admin run-now action ("manual" trigger) and from
// the post-intake threshold trigger ("post_intake"; see grooming-trigger.ts).
// Reads the admin config, gates on it, builds the LLM client from it, and runs
// all due slices via runDueCuration as the system-memory-curator actor. It never
// runs unless grooming is enabled AND the LLM config is complete AND the token
// can be decrypted (it must never run on an incomplete config, §7.1).
//
// The LLM client builder is injectable for testing; in production it defaults to
// the OpenAI-compatible client.

import { SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import { migrateCuratorAddendum, readAddendumStatus, readJobAddendum } from "./curator-addendum.js";
import {
  migrateCuratorEnablement,
  migrateCuratorGroomingSchedule,
  readCuratorConfig,
  readLastScheduledGroomAt,
  writeLastScheduledGroomAt,
} from "./curator-config.js";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "./curator-consumers.js";
import {
  type CuratorTrigger,
  type RunDueCurationSummary,
  runDueCuration,
} from "./curator-enqueue.js";
import { forceProposeDeps } from "./curator-force-propose.js";
import { type LlmClient, createCuratorLlmClient } from "./curator-llm-client.js";
import { isScheduleDue } from "./curator-schedule.js";
import type { RunCurationCaps } from "./curator-worker.js";
import type { LibrarianStore } from "./store/librarian-store.js";

export type CuratorTickSkipReason = "disabled" | "incomplete_config" | "no_token";

export type CuratorTickResult =
  | { ran: true; summary: RunDueCurationSummary }
  | { ran: false; reason: CuratorTickSkipReason };

export interface CuratorTickOptions {
  store: LibrarianStore;
  now?: Date;
  /** Default "schedule"; admin run-now passes "manual". */
  trigger?: CuratorTrigger;
  /** manual/maintenance may bypass the input-hash idempotency skip. */
  bypassSkip?: boolean;
  caps?: RunCurationCaps;
  /** Injectable LLM client builder (defaults to the OpenAI-compatible client). */
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
}

export async function runCuratorTick(options: CuratorTickOptions): Promise<CuratorTickResult> {
  const { store } = options;
  // Preserve a pre-existing curator.llm.* install: seed the per-consumer config
  // from it on first run (idempotent — a no-op once any provider exists).
  migrateLegacyCuratorLlm(store);
  // Seed grooming's unified enablement key from the legacy curator.enabled
  // setting (idempotent, no-clobber). Intake's env→setting seed runs at the http
  // boot where LIBRARIAN_CONSOLIDATOR is available; this tick migrates grooming.
  migrateCuratorEnablement(store);
  // Seed the grooming schedule pair + moved auto-apply policy keys from their
  // legacy locations once (spec 045 D-8; idempotent, no-clobber).
  migrateCuratorGroomingSchedule(store);
  // Move the legacy curator.prompt_addendum setting into the committed
  // grooming-addendum.md vault file once (spec 044 D-1; idempotent, no-clobber).
  migrateCuratorAddendum(store);
  const config = readCuratorConfig(store);
  const llm = readConsumerConfig(store, "grooming");

  if (!config.enabled) return { ran: false, reason: "disabled" };
  if (!llm.isOperational) return { ran: false, reason: "incomplete_config" };

  // The token is configured (isOperational ⇒ hasToken); decryption can still fail
  // if the server is missing the master key — treat that as "not runnable".
  let token: string | null;
  try {
    token = resolveConsumerToken(store, "grooming");
  } catch {
    return { ran: false, reason: "no_token" };
  }
  if (!token) return { ran: false, reason: "no_token" };

  const buildClient =
    options.buildClient ??
    ((conn, secret) =>
      createCuratorLlmClient({
        endpoint: conn.endpoint,
        token: secret,
        model: conn.model,
        timeoutMs: conn.timeoutMs,
      }));

  const summary = await runDueCuration({
    store,
    now: options.now ?? new Date(),
    llmClient: buildClient(
      { endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs },
      token,
    ),
    actorId: SYSTEM_ACTOR_IDS.memoryCurator,
    policy: { level: config.defaultAutoApply, confidenceThreshold: config.autoApplyConfidence },
    // The grooming addendum now lives in a git-committed vault file (spec 044
    // D-1); read it from there (fail-soft "" when the file is absent).
    promptAddendum: readJobAddendum(store, "grooming").content,
    // Under-evaluation force-propose (spec 044 D-3): read the addendum status ONCE
    // per tick (the natural seam, store available). When under_evaluation, no op
    // auto-applies and proposals are tagged with the eval version. Accepted (the
    // default) → byte-identical to before D3a.
    ...forceProposeDeps(readAddendumStatus(store, "grooming")),
    model: { provider: llm.providerId, name: llm.model },
    trigger: options.trigger ?? "schedule",
    ...(options.bypassSkip !== undefined ? { bypassSkip: options.bypassSkip } : {}),
    // Bounded grooming runs (ADR 0005): the configured per-run memory cap
    // (curator.grooming.max_memories) flows into every run's evidence gather so a
    // single oversized slice can't exceed the LLM timeout. An explicit options.caps
    // (manual/maintenance, tests) overrides it.
    caps: { maxMemories: config.maxMemoriesPerRun, ...options.caps },
  });
  return { ran: true, summary };
}

export type ScheduledGroomingSkipReason = "disabled" | "not_due";

export type ScheduledGroomingResult =
  // A scheduled pass was attempted; the inner result is the pass runner's verdict
  // (ran:true with its summary, or ran:false with the pass's own skip reason).
  | CuratorTickResult
  // The schedule gate refused before any pass ran.
  | { ran: false; reason: ScheduledGroomingSkipReason };

export interface ScheduledGroomingOptions {
  store: LibrarianStore;
  /** Evaluation time; injected so the due-check is deterministic in tests. */
  now?: Date;
  /**
   * Bypass the `config.enabled` self-gate (spec 045 D-3 / D-4). Default false: the
   * scheduled poll does nothing when grooming is disabled. The admin run-now caller
   * (plan 046 T8) sets this true to run a disabled-but-configured job on demand —
   * the underlying pass's LLM-config/token gates still apply.
   */
  allowDisabled?: boolean;
  /**
   * Injectable pass runner (defaults to `runCuratorTick` tagged `"schedule"`). The
   * scheduled entry owns the WHEN (the wall-clock due-check); the pass runner owns
   * the WHICH (input-hash idempotency per slice) and the actual LLM work. Injectable
   * for tests so the schedule gate can be exercised network-free.
   */
  runPass?: (store: LibrarianStore, now: Date) => Promise<CuratorTickResult>;
}

/**
 * The schedulable grooming entry (spec 045 D-3, plan 046 T6). The boot scheduler
 * (T7) polls this on a fixed internal cadence; it decides WHETHER a full grooming
 * pass is due and runs one when it is.
 *
 * Order of gates:
 *  1. **Enable gate** — self-gates on `config.enabled` (returns `disabled`) unless
 *     `allowDisabled` is set (the run-now seam, mirroring the intake tick's gate).
 *  2. **Schedule gate** — reads the grooming schedule (`intervalDays`,
 *     `scheduleTime`) and the LAST SCHEDULED-PASS timestamp
 *     (`curator.grooming.last_scheduled_run_at`); runs a pass only when
 *     `isScheduleDue(now, lastScheduledRunAt, …)`, else returns `not_due`.
 *
 * On a COMPLETED scheduled pass (the runner returns `ran:true`) the pass timestamp
 * is stamped so the next due-check advances. A pass that could not run (incomplete
 * config / no token) does NOT advance the schedule — the next poll retries once the
 * config is fixed. The timestamp is owned by SCHEDULED passes only: the post-intake
 * trigger and run-now never write it, so the nightly cadence stays predictable
 * regardless of ad-hoc grooms.
 */
export async function runScheduledGrooming(
  options: ScheduledGroomingOptions,
): Promise<ScheduledGroomingResult> {
  const { store } = options;
  const now = options.now ?? new Date();

  // Mirror the tick's migrations so a first poll on a freshly-upgraded install reads
  // the seeded schedule keys (idempotent, no-clobber).
  migrateCuratorEnablement(store);
  migrateCuratorGroomingSchedule(store);
  const config = readCuratorConfig(store);

  // 1. Enable gate (the run-now seam bypasses it, like the intake tick).
  if (!options.allowDisabled && !config.enabled) {
    return { ran: false, reason: "disabled" };
  }

  // 2. Schedule gate — days-only wall-clock due-check against the last scheduled run.
  const due = isScheduleDue(now, readLastScheduledGroomAt(store), {
    intervalDays: config.intervalDays,
    time: config.scheduleTime,
  });
  if (!due) return { ran: false, reason: "not_due" };

  const runPass =
    options.runPass ?? ((s: LibrarianStore, at: Date) => runCuratorTick({ store: s, now: at }));
  const result = await runPass(store, now);

  // Advance the schedule ONLY on a completed pass. A pass that couldn't run leaves
  // the timestamp untouched so the next poll retries this window.
  if (result.ran) writeLastScheduledGroomAt(store, now);
  return result;
}
