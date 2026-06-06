// Curator tick (spec §12 + §14) — the config-driven entrypoint the server-side
// scheduler calls on a (serial) timer, and the admin run-now action calls with a
// manual trigger. Reads the admin config, gates on it, builds the LLM client from
// it, and runs all due slices via runDueCuration as the system-memory-curator
// actor. It never runs unless curation is enabled AND the LLM config is complete
// AND the token can be decrypted (the scheduler must never run on an incomplete
// config, §7.1).
//
// The LLM client builder is injectable for testing; in production it defaults to
// the OpenAI-compatible client.

import { SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import { readCuratorConfig } from "./curator-config.js";
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
    promptAddendum: config.promptAddendum,
    model: { provider: llm.providerId, name: llm.model },
    trigger: options.trigger ?? "schedule",
    ...(options.bypassSkip !== undefined ? { bypassSkip: options.bypassSkip } : {}),
    ...(options.caps !== undefined ? { caps: options.caps } : {}),
  });
  return { ran: true, summary };
}
