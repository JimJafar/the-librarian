// Consolidator tick (spec 035 §F5) — the config-driven entrypoint the
// server-side scheduler calls on a (serial) timer, and an admin run-now action
// can call directly. It uses the `intake` consumer's own LLM connection (042 2A
// — intake and grooming each pick their own provider+model), builds the client
// from it, and runs one inbox sweep via store.consolidateInbox.
//
// Enablement (the `curator.intake.enabled` setting, spec 043 D-E) is decided by
// the caller (the http boot only starts this scheduler when the setting is on),
// so the tick itself only gates on a complete + decryptable LLM connection and a
// supporting backend. The LLM client builder is injectable for testing;
// production defaults to the OpenAI-compatible client.

import type { ConsolidationThresholds, SweepSummary } from "./consolidator/index.js";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "./curator-consumers.js";
import { type LlmClient, createCuratorLlmClient } from "./curator-llm-client.js";
import { maybeTriggerGroomingAfterIntake } from "./grooming-trigger.js";
import type { LibrarianStore } from "./store/librarian-store.js";

export type ConsolidatorTickSkipReason = "incomplete_config" | "no_token";

export type ConsolidatorTickResult =
  | { ran: true; summary: SweepSummary }
  | { ran: false; reason: ConsolidatorTickSkipReason };

export interface ConsolidatorTickOptions {
  store: LibrarianStore;
  thresholds?: ConsolidationThresholds;
  /** Stale-claim TTL passed through to the sweep reaper. */
  lockTtlMs?: number;
  /** Injectable LLM client builder (defaults to the OpenAI-compatible client). */
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
  /**
   * Post-intake grooming trigger (spec 043 D-A). After the sweep + decision log,
   * check the threshold/debounce and enqueue a `post_intake` groom if armed. Default
   * on; set false to suppress (e.g. when a separate process owns grooming). The hook
   * is fail-soft — it can never fail the sweep. Injectable for tests.
   */
  triggerGrooming?: boolean | ((store: LibrarianStore) => Promise<unknown>);
  /** Trigger evaluation time (debounce math); defaults to now. Mostly for tests. */
  now?: Date;
}

export async function runConsolidatorTick(
  options: ConsolidatorTickOptions,
): Promise<ConsolidatorTickResult> {
  const { store } = options;
  // Preserve a pre-existing curator.llm.* install (idempotent once migrated).
  migrateLegacyCuratorLlm(store);
  // The intake job's own LLM connection — its enablement is the caller's
  // `curator.intake.enabled` setting (gated at the http boot), not read here.
  const llm = readConsumerConfig(store, "intake");
  if (!llm.isOperational) return { ran: false, reason: "incomplete_config" };

  let token: string | null;
  try {
    token = resolveConsumerToken(store, "intake");
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

  const summary = await store.consolidateInbox({
    llmClient: buildClient(
      { endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs },
      token,
    ),
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
    ...(options.lockTtlMs !== undefined ? { lockTtlMs: options.lockTtlMs } : {}),
  });

  // Post-intake grooming trigger (spec 043 D-A) — the natural seam: the sweep is done
  // and its C1 decision log is written, so the applied-op count is complete. Fail-soft
  // by contract (intake is the hot path — AGENTS.md "never block the user's turn"): the
  // hook swallows its own errors, and we still guard the call so nothing here can fail
  // the sweep that already succeeded.
  if (options.triggerGrooming !== false) {
    try {
      await maybeTriggerGroomingAfterIntake({
        store,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(typeof options.triggerGrooming === "function"
          ? { runGroom: options.triggerGrooming }
          : {}),
      });
    } catch {
      /* unreachable — maybeTriggerGroomingAfterIntake is itself fail-soft — but the
         sweep must never fail on the trigger, belt-and-braces. */
    }
  }

  return { ran: true, summary };
}
