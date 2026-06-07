// Grooming dry-run over the corpus with a candidate addendum (spec 044 D-4 /
// decision D-4, the "see what a new addendum would do before committing it" tool).
//
// Before an admin commits a new grooming addendum they want to SEE what it would
// do. A dry-run runs a CANDIDATE (uncommitted) addendum over the existing corpus
// in propose-mode, producing a reviewable batch of proposals WITHOUT committing the
// candidate addendum live and WITHOUT auto-applying anything.
//
// GROOMING ONLY. The intake input (the inbox) is consumed on apply — not replayable
// (spec 044 "what's there"), so there is deliberately no intake dry-run (the same
// reason intake has no re-evaluate in D3c). This module is grooming-hardcoded; the
// tRPC layer never offers a dry-run for intake.
//
// This is the same DRIVER SHAPE as D3c's `reEvaluateGroomingProposals` (a per-slice
// `runCuration` over the real grooming worker with force-propose deps), with two
// deliberate differences:
//   1. it threads the CANDIDATE addendum string into the prompt (as `promptAddendum`
//      — the prompt builder redacts it) instead of the committed `readJobAddendum`;
//      the candidate is NEVER written to the vault (in-memory only — a dry-run must
//      not change the live grooming-addendum.md, its status, or its version);
//   2. it tags proposals `dry_run` (+ a candidate label) instead of an
//      addendum_version, so the throwaway batch is distinguishable from real
//      proposals (the D7 dashboard filters them; they can be discarded freely).
//
// FORCE-PROPOSE IS UNCONDITIONAL. A dry-run forces every op to a proposal and auto-
// archives to skip — nothing auto-applies, ever, even at confidence 1.0 (defence-in-
// depth). This is independent of the job's real `addendum_status`: a dry-run is a
// pure preview and changes no live state.
//
// SCOPE:
//   - a `slice` is given → run that ONE slice synchronously and return fast (the
//     latency-sensitive "dry-run this slice" path);
//   - no `slice` → run every slice that has curatable content ("dry-run everything").
//     Each slice's run is fail-soft (one slice's failure never wedges the rest); the
//     tRPC layer runs the whole-corpus variant as background work.

import { SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import { readConsumerConfig, resolveConsumerToken } from "./curator-consumers.js";
import { readGroomingConfig } from "./grooming-config.js";
import type { EvidenceSlice } from "./grooming-evidence.js";
import { type LlmClient, createGroomingLlmClient } from "./grooming-llm-client.js";
import { type RunCurationCaps, runCuration } from "./grooming-worker.js";
import type { LibrarianStore } from "./store/librarian-store.js";

/** Why a dry-run could not run (mirrors GroomingTickSkipReason). */
export type DryRunSkipReason = "disabled" | "incomplete_config" | "no_token";

/**
 * The outcome of `dryRunGrooming`.
 *  - `{ ran: true, scope, slicesRun }`: ran; `scope` is "slice" (one slice) or
 *    "corpus" (all slices), `slicesRun` = how many slices were actually judged.
 *  - `{ ran: false, reason }`: grooming isn't runnable (disabled / incomplete
 *    config / no token) — nothing was proposed.
 */
export type DryRunResult =
  | { ran: true; scope: "slice" | "corpus"; slicesRun: number }
  | { ran: false; reason: DryRunSkipReason };

export interface DryRunGroomingOptions {
  store: LibrarianStore;
  /** The candidate (uncommitted) addendum — threaded into the prompt, never written. */
  candidateAddendum: string;
  /**
   * An optional label for the candidate batch (e.g. "candidate v2" / a hash); tags
   * every dry-run proposal so a batch can be identified. Caller-supplied.
   */
  candidateLabel?: string;
  /** Dry-run ONE slice (synchronous, fast). Omit to dry-run the whole corpus. */
  slice?: EvidenceSlice;
  caps?: RunCurationCaps;
  /** Injectable LLM client builder (defaults to the OpenAI-compatible client). */
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
}

/**
 * Run a candidate grooming addendum over the corpus (or one slice) in propose-mode,
 * producing a reviewable batch tagged `dry_run` — WITHOUT committing the candidate
 * addendum and WITHOUT auto-applying anything. See the module header for the full
 * contract. Grooming only.
 */
export async function dryRunGrooming(options: DryRunGroomingOptions): Promise<DryRunResult> {
  const { store, candidateAddendum } = options;

  // Gate exactly like the tick (enabled / operational config / decryptable token).
  // A dry-run never runs on a non-runnable grooming config (§7.1).
  const config = readGroomingConfig(store);
  const llm = readConsumerConfig(store, "grooming");
  if (!config.enabled) return { ran: false, reason: "disabled" };
  if (!llm.isOperational) return { ran: false, reason: "incomplete_config" };
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
      createGroomingLlmClient({
        endpoint: conn.endpoint,
        token: secret,
        model: conn.model,
        timeoutMs: conn.timeoutMs,
      }));
  const llmClient = buildClient(
    { endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs },
    token,
  );

  const slices = options.slice ? [options.slice] : store.listGroomingSlices();
  const caps = options.caps;

  // Run the candidate over each slice via the REAL worker (judge → validate →
  // apply): `bypassSkip` forces a fresh run past the input-hash idempotency, the
  // candidate addendum reaches the prompt via `promptAddendum` (redacted there,
  // never written to the vault), and `dryRun` force-proposes every op (nothing auto-
  // applies) + tags each proposal `dry_run` (+ the candidate label). Fail-soft per
  // slice — one slice's failure never aborts the rest (load-bearing for the whole-
  // corpus background path).
  let slicesRun = 0;
  for (const slice of slices) {
    try {
      await runCuration(slice, {
        store,
        llmClient,
        trigger: "manual",
        actorId: SYSTEM_ACTOR_IDS.memoryCurator,
        policy: {
          level: config.defaultAutoApply,
          confidenceThreshold: config.autoApplyConfidence,
        },
        model: { provider: llm.providerId, name: llm.model },
        bypassSkip: true,
        // The candidate addendum is in-memory only — passed to the prompt, NEVER
        // written to grooming-addendum.md (the load-bearing dry-run invariant).
        ...(candidateAddendum !== "" ? { promptAddendum: candidateAddendum } : {}),
        // Force-propose unconditionally + tag dry-run (no addendum_version).
        dryRun: true,
        ...(options.candidateLabel !== undefined
          ? { dryRunCandidate: options.candidateLabel }
          : {}),
        ...(caps !== undefined ? { caps } : {}),
      });
      slicesRun++;
    } catch {
      /* fail-soft: a slice's dry-run failure never wedges the batch */
    }
  }

  return { ran: true, scope: options.slice ? "slice" : "corpus", slicesRun };
}
