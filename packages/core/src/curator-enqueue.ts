// Curator enqueue + run loop (spec §12 enqueueDueMemoryCurationRuns + §10.1
// locking). A pass attempts EVERY slice in the slice set, composing per-slice
// locking with runCuration:
//
//   for each slice:
//     - if a run is already in progress and not stale → skip (locked);
//     - if the in-progress run is older than the lock TTL → reclaim it (a crashed
//       worker must not block a slice forever, §10.1) then run;
//     - otherwise run it (which creates+starts the run = takes the lock, and
//       completes/fails it = releases).
//
// The per-slice TIME-INTERVAL gate is RETIRED (spec 045 D-3a / plan 046 T4): a
// scheduled or run-now pass no longer filters slices by how recently they last
// groomed. Which slices actually do work is decided solely by the content
// input-hash IDEMPOTENCY inside runCuration (skip a slice whose computeInputHash
// matches a completed apply-run, unless bypassSkip) — an unchanged slice costs no
// LLM call; a changed slice runs. The schedule (spec 045 D-3) decides WHEN a pass
// runs; max_memories (ADR 0005) bounds each run.
//
// The "running" run row IS the lock. This is correct for the v1 PREFERRED
// single-process scheduler (§14): the server-side tick must run SERIALLY (await
// this before the next tick), so a live run is never reclaimed mid-flight — the
// TTL reclaim only fires for a run left "running" by a CRASHED worker. Lifecycle
// transitions are status-guarded (curation-store), so a reclaim can never be
// undone by a late completion. FOLLOW-UP (tracked): true multi-process atomic
// mutual exclusion (a partial-unique index on the running row) + a worker
// heartbeat, for running the scheduler in more than one process.
//
// The LLM client is injected, so the loop is testable without network. The
// server-side tick calls this on a timer; admin run-now calls it with a manual
// trigger that bypasses the input-hash skip. One slice's failure never aborts the
// rest of the batch.

import { type ApplyPolicy } from "./curator-apply-policy.js";
import type { LlmClient } from "./curator-llm-client.js";
import type { RunCurationCaps } from "./curator-worker.js";
import { runCuration } from "./curator-worker.js";
import type { LibrarianStore } from "./store/librarian-store.js";

// The only valid run triggers (§12). manual = admin run-now; maintenance = trusted
// internal code; post_intake = the spec 043 D-A threshold trigger (a groom enqueued
// after an intake sweep crosses curator.grooming.trigger_threshold). schedule is the
// retired wall-clock cron — kept as the historical default of runCuratorTick /
// runDueCuration so existing call-sites and run records don't churn, but nothing
// schedules on a timer any more (043 D-A removed the curator createSerialScheduler).
// No agent-reachable trigger exists.
export type CuratorTrigger = "schedule" | "manual" | "maintenance" | "post_intake";

// A run still "running" past this age is treated as a crashed-worker lock and
// reclaimed. Set well above the worst-case run time so a live run is never
// reclaimed; with a serial single-process tick, reclaim only fires after a crash.
const DEFAULT_LOCK_TTL_MS = 60 * 60_000; // 60 minutes

export interface RunDueCurationOptions {
  store: LibrarianStore;
  now: Date;
  llmClient: LlmClient;
  /** Curator actor for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  policy: ApplyPolicy;
  promptAddendum?: string;
  /** Under-evaluation force-propose (spec 044 D-3); see RunCurationOptions. */
  underEvaluation?: boolean;
  /** The addendum version (git hash) under evaluation; tags produced proposals. */
  addendumVersion?: string | null;
  model: { provider: string; name: string };
  caps?: RunCurationCaps;
  /** Default "schedule". */
  trigger?: CuratorTrigger;
  /** manual/maintenance may bypass the input-hash idempotency skip (§10.2). */
  bypassSkip?: boolean;
  /** A run still "running" past this age is treated as stale and reclaimed. */
  lockTtlMs?: number;
}

export interface RunDueCurationSummary {
  /** Slices ATTEMPTED this pass — the full slice set (the interval gate is retired). */
  due: number;
  ran: number;
  skippedLocked: number;
  skippedIdempotent: number;
  reclaimedStaleLocks: number;
  /** Slices whose run-loop body threw (store error etc.); the rest still ran. */
  errored: number;
}

export async function runDueCuration(
  options: RunDueCurationOptions,
): Promise<RunDueCurationSummary> {
  const { store, now } = options;
  const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const summary: RunDueCurationSummary = {
    due: 0,
    ran: 0,
    skippedLocked: 0,
    skippedIdempotent: 0,
    reclaimedStaleLocks: 0,
    errored: 0,
  };

  // A pass attempts EVERY slice (spec 045 D-3a): no per-slice interval filter.
  // Idempotency inside runCuration is what skips unchanged slices.
  const slices = store.listCuratorSlices();
  summary.due = slices.length;

  for (const slice of slices) {
    // One slice's failure (store error etc.) must not abort the whole batch.
    try {
      const lock = store.findRunningRun(slice);
      if (lock) {
        if (now.getTime() - lock.startedAt.getTime() < lockTtlMs) {
          summary.skippedLocked++;
          continue; // an active run holds the slice lock
        }
        // Stale lock (crashed worker): reclaim it, then proceed.
        store.failCurationRun(lock.id, { error: "stale_lock_reclaimed" });
        summary.reclaimedStaleLocks++;
      }

      const run = await runCuration(slice, {
        store,
        llmClient: options.llmClient,
        trigger: options.trigger ?? "schedule",
        actorId: options.actorId,
        policy: options.policy,
        model: options.model,
        ...(options.underEvaluation
          ? { underEvaluation: true, addendumVersion: options.addendumVersion }
          : {}),
        ...(options.promptAddendum !== undefined ? { promptAddendum: options.promptAddendum } : {}),
        ...(options.caps !== undefined ? { caps: options.caps } : {}),
        ...(options.bypassSkip !== undefined ? { bypassSkip: options.bypassSkip } : {}),
      });
      if (run === null) summary.skippedIdempotent++;
      else summary.ran++;
    } catch {
      summary.errored++;
    }
  }

  return summary;
}
