// Consolidator tick (spec 035 §F5) — the config-driven entrypoint the
// server-side scheduler calls on a (serial) timer, and an admin run-now action
// can call directly. It uses the `intake` consumer's own LLM connection (042 2A
// — intake and grooming each pick their own provider+model), builds the client
// from it, and runs one inbox sweep via store.consolidateInbox.
//
// Enablement (the LIBRARIAN_CONSOLIDATOR opt-in) is decided by the caller (the
// http boot only starts this scheduler when enabled), so the tick itself only
// gates on a complete + decryptable LLM connection and a supporting backend. The
// LLM client builder is injectable for testing; production defaults to the
// OpenAI-compatible client.

import type { ConsolidationThresholds, SweepSummary } from "./consolidator/index.js";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "./curator-consumers.js";
import { type LlmClient, createCuratorLlmClient } from "./curator-llm-client.js";
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
}

export async function runConsolidatorTick(
  options: ConsolidatorTickOptions,
): Promise<ConsolidatorTickResult> {
  const { store } = options;
  // Preserve a pre-existing curator.llm.* install (idempotent once migrated).
  migrateLegacyCuratorLlm(store);
  // The intake job's own LLM connection — its enablement is the caller's
  // LIBRARIAN_CONSOLIDATOR opt-in, not a curator flag.
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
  return { ran: true, summary };
}
