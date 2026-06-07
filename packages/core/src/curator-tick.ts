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
    schedule: { intervalMinutes: config.intervalMinutes },
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
