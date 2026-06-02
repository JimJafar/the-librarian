// Consolidator tick (spec 035 §F5) — the config-driven entrypoint the
// server-side scheduler calls on a (serial) timer, and an admin run-now action
// can call directly. It reuses the SHARED server-side LLM brain config (the same
// connection the curator uses — there is one LLM brain, the classifier removed),
// builds the client from it, and runs one inbox sweep via store.consolidateInbox.
//
// Enablement (the LIBRARIAN_CONSOLIDATOR opt-in) is decided by the caller (the
// http boot only starts this scheduler when enabled), so the tick itself only
// gates on a complete + decryptable LLM connection and a supporting backend. The
// LLM client builder is injectable for testing; production defaults to the
// OpenAI-compatible client.

import type { ConsolidationThresholds, SweepSummary } from "./consolidator/index.js";
import { type CuratorConfig, readCuratorConfig, resolveCuratorToken } from "./curator-config.js";
import { type LlmClient, createCuratorLlmClient } from "./curator-llm-client.js";
import { CONSOLIDATOR_REQUIRES_MARKDOWN, type LibrarianStore } from "./store/librarian-store.js";

export type ConsolidatorTickSkipReason = "incomplete_config" | "no_token" | "unsupported_backend";

export type ConsolidatorTickResult =
  | { ran: true; summary: SweepSummary }
  | { ran: false; reason: ConsolidatorTickSkipReason };

export interface ConsolidatorTickOptions {
  store: LibrarianStore;
  thresholds?: ConsolidationThresholds;
  /** Stale-claim TTL passed through to the sweep reaper. */
  lockTtlMs?: number;
  /** Injectable LLM client builder (defaults to the OpenAI-compatible client). */
  buildClient?: (llm: CuratorConfig["llm"], token: string) => LlmClient;
}

export async function runConsolidatorTick(
  options: ConsolidatorTickOptions,
): Promise<ConsolidatorTickResult> {
  const { store } = options;
  const config = readCuratorConfig(store);

  // Reuse the curator's LLM connection (the one server-side model) — but NOT its
  // `enabled` flag: the consolidator's enablement is the caller's LIBRARIAN_CONSOLIDATOR opt-in.
  if (!config.isLlmComplete) return { ran: false, reason: "incomplete_config" };

  let token: string | null;
  try {
    token = resolveCuratorToken(store);
  } catch {
    return { ran: false, reason: "no_token" };
  }
  if (!token) return { ran: false, reason: "no_token" };

  const buildClient =
    options.buildClient ??
    ((llm, secret) =>
      createCuratorLlmClient({
        endpoint: llm.endpoint,
        token: secret,
        model: llm.model,
        timeoutMs: llm.timeoutMs,
      }));

  try {
    const summary = await store.consolidateInbox({
      llmClient: buildClient(config.llm, token),
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      ...(options.lockTtlMs !== undefined ? { lockTtlMs: options.lockTtlMs } : {}),
    });
    return { ran: true, summary };
  } catch (error) {
    // consolidateInbox rejects on a non-markdown backend (the inbox is vault-only).
    // Match the shared sentinel exactly so a real consolidation error never gets
    // misclassified as an unsupported backend.
    if (error instanceof Error && error.message === CONSOLIDATOR_REQUIRES_MARKDOWN) {
      return { ran: false, reason: "unsupported_backend" };
    }
    throw error;
  }
}
