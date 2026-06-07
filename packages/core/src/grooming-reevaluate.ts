// Re-evaluate grooming proposals for an addendum version (spec 044 D-3 / decision
// D-3, the "Re-evaluate proposals" escape hatch — Task D3c).
//
// While a grooming addendum is `under_evaluation` the curator force-proposes every
// would-be auto-apply (D3a) and tags each proposal `curator_note.addendum_version
// = <the eval version git hash>`. If the admin keeps editing the addendum (a new
// commit → a new eval version), the proposals tagged with the EARLIER version go
// stale. "Re-evaluate proposals" is the batch escape hatch: it discards exactly
// that version's stale grooming proposals and re-runs grooming over their slices
// under the CURRENT addendum, producing a fresh, re-tagged batch.
//
// GROOMING ONLY. Spec 044 ("what's there"): grooming's input is the replayable
// corpus (curator-evidence / curator-source-vault), but the intake input (the
// inbox) is CONSUMED on apply — not replayable. So an intake proposal has no
// original judge input to re-run; there is deliberately no intake re-evaluate
// (mirrors why intake has no dry-run in D4). The tRPC layer returns an
// `intake_not_replayable` result for `job: "intake"` rather than calling this.
//
// MECHANISM (reuses the real grooming pipeline — NOT a parallel judging path):
//   1. read the grooming eval version (readAddendumStatus); no version / no tagged
//      proposals → a clean no-op `{ reEvaluated: true, count: 0 }`;
//   2. derive the DISTINCT slices the tagged proposals belong to (via the store's
//      own slice enumeration + evidence — so the partitioning never diverges from
//      what a real grooming run would see), so ONLY those slices are re-judged (no
//      collateral re-judging of unrelated slices);
//   3. gate exactly like the tick (enabled / operational config / decryptable
//      token) — if grooming can't run we DON'T discard anything (fail-soft: never
//      leave the admin with the stale proposals gone AND no fresh batch);
//   4. ARCHIVE the stale tagged proposals (the discard mechanism — the same status
//      transition the admin's "reject" gives an unwanted proposal; no stale
//      duplicate is left behind), then run `runCuration` over each affected slice
//      with `bypassSkip` (force a fresh run) and the CURRENT force-propose deps, so
//      fresh proposals land at `proposed` re-tagged with the current eval version.
//   Each slice's re-run is fail-soft (one slice's failure never wedges the batch);
//   the stale-proposal discard only happens for slices we actually re-run.

import { SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import { readAddendumStatus, readJobAddendum } from "./curator-addendum.js";
import { readConsumerConfig, resolveConsumerToken } from "./curator-consumers.js";
import { readGroomingConfig } from "./grooming-config.js";
import type { EvidenceSlice } from "./grooming-evidence.js";
import { forceProposeDeps } from "./grooming-force-propose.js";
import { type LlmClient, createGroomingLlmClient } from "./grooming-llm-client.js";
import { type RunCurationCaps, runCuration } from "./grooming-worker.js";
import { MemoryStatus } from "./schemas/common.js";
import type { LibrarianStore } from "./store/librarian-store.js";
import type { Memory } from "./store/memory-store.js";

/** Why a re-evaluate could not run (mirrors GroomingTickSkipReason). */
export type ReEvaluateSkipReason = "disabled" | "incomplete_config" | "no_token";

/**
 * The outcome of `reEvaluateGroomingProposals`.
 *  - `{ reEvaluated: true, count }`: ran (count = the stale proposals discarded +
 *    re-judged; 0 is a clean no-op — nothing was tagged with the eval version).
 *  - `{ reEvaluated: false, reason }`: grooming isn't runnable, so NOTHING was
 *    discarded (fail-soft) — the admin still has the stale batch to act on.
 */
export type ReEvaluateResult =
  | { reEvaluated: true; count: number }
  | { reEvaluated: false; reason: ReEvaluateSkipReason };

export interface ReEvaluateGroomingOptions {
  store: LibrarianStore;
  now?: Date;
  caps?: RunCurationCaps;
  /** Injectable LLM client builder (defaults to the OpenAI-compatible client). */
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
}

const DEFAULT_MAX_MEMORIES = 200;

/** A proposal tagged with the eval version we're re-evaluating. */
function isTaggedProposal(memory: Memory, evalVersion: string): boolean {
  return (
    memory.status === MemoryStatus.Proposed &&
    typeof memory.curator_note === "object" &&
    memory.curator_note !== null &&
    (memory.curator_note as Record<string, unknown>).addendum_version === evalVersion
  );
}

/**
 * Re-evaluate the grooming proposals tagged with the current eval version: discard
 * them and re-run grooming over their slices under the current addendum, producing
 * a fresh batch. See the module header for the full contract. Intake is handled at
 * the tRPC boundary (not replayable) and never reaches here.
 */
export async function reEvaluateGroomingProposals(
  options: ReEvaluateGroomingOptions,
): Promise<ReEvaluateResult> {
  const { store } = options;
  const status = readAddendumStatus(store, "grooming");
  const evalVersion = status.evalVersion;

  // No eval version pinned → nothing was tagged → clean no-op. (Also the case
  // after Accept, which clears the version: re-judging is moot.)
  if (!evalVersion) return { reEvaluated: true, count: 0 };

  // Find the proposals tagged with this version. The memory store has no
  // curator_note filter, so list proposals and filter in-memory.
  const tagged = store
    .listAll({ status: MemoryStatus.Proposed })
    .filter((m) => isTaggedProposal(m, evalVersion));
  if (tagged.length === 0) return { reEvaluated: true, count: 0 };

  // Derive the DISTINCT slices the tagged proposals belong to BEFORE we discard
  // them (an archived proposal leaves its slice's evidence). Use the store's own
  // slice enumeration + evidence so the partitioning matches a real grooming run
  // exactly — never re-derive a slice from a memory's raw fields.
  const taggedIds = new Set(tagged.map((m) => m.id));
  const caps = options.caps ?? {};
  const maxMemories = caps.maxMemories ?? DEFAULT_MAX_MEMORIES;
  const affected: EvidenceSlice[] = [];
  for (const slice of store.listGroomingSlices()) {
    const evidence = store.gatherMemoryEvidence(slice, {
      maxMemories,
      ...(caps.maxBodyChars !== undefined ? { maxBodyChars: caps.maxBodyChars } : {}),
    });
    if (evidence.proposedMemories.some((m) => taggedIds.has(m.id))) affected.push(slice);
  }

  // Gate exactly like the tick. If grooming can't run we must NOT discard the
  // stale proposals (fail-soft: never leave the admin with neither the stale batch
  // NOR a fresh one). Returned reason mirrors runGroomingTick's skip reasons.
  const config = readGroomingConfig(store);
  const llm = readConsumerConfig(store, "grooming");
  if (!config.enabled) return { reEvaluated: false, reason: "disabled" };
  if (!llm.isOperational) return { reEvaluated: false, reason: "incomplete_config" };
  let token: string | null;
  try {
    token = resolveConsumerToken(store, "grooming");
  } catch {
    return { reEvaluated: false, reason: "no_token" };
  }
  if (!token) return { reEvaluated: false, reason: "no_token" };

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

  // Discard the stale tagged proposals (the same archived transition "reject"
  // gives an unwanted proposal), so the re-run never leaves a stale duplicate.
  // Fail-soft per proposal — a single archive failure must not wedge the batch.
  for (const proposal of tagged) {
    try {
      store.archiveMemory(proposal.id, SYSTEM_ACTOR_IDS.memoryCurator);
    } catch {
      /* fail-soft: leave this one; the re-run still refreshes the slice */
    }
  }

  // Re-run grooming over each affected slice under the CURRENT addendum. Reuse the
  // real worker (judge → validate → apply): `bypassSkip` forces a fresh run past
  // the input-hash idempotency, and the force-propose deps re-tag fresh proposals
  // with the current eval version (no auto-apply while under_evaluation). Fail-soft
  // per slice — one slice's failure never aborts the rest.
  const promptAddendum = readJobAddendum(store, "grooming").content;
  // `status` is still under_evaluation (we don't change it here — Accept/Roll-back
  // do), so these deps re-tag fresh proposals with the SAME eval version.
  const forceProp = forceProposeDeps(status);
  for (const slice of affected) {
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
        ...(promptAddendum !== "" ? { promptAddendum } : {}),
        ...forceProp,
        ...(caps.maxMemories !== undefined || caps.maxBodyChars !== undefined ? { caps } : {}),
      });
    } catch {
      /* fail-soft: a slice's re-run failure never wedges the batch */
    }
  }

  return { reEvaluated: true, count: tagged.length };
}
