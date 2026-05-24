// Curator enqueue + run loop (spec §12 enqueueDueMemoryCurationRuns + §10.1
// locking). Composes due-slice selection with per-slice locking and runCuration:
//
//   for each due slice:
//     - if a run is already in progress and not stale → skip (locked);
//     - if the in-progress run is older than the lock TTL → reclaim it (a crashed
//       worker must not block a slice forever, §10.1) then run;
//     - otherwise run it (which creates+starts the run = takes the lock, and
//       completes/fails it = releases).
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
import type { ScheduleConfig } from "./curator-schedule.js";
import { findRunningRun, selectDueSlices } from "./curator-scheduler.js";
import type { RunCurationCaps } from "./curator-worker.js";
import { runCuration } from "./curator-worker.js";
import type { LibrarianStore } from "./store/librarian-store.js";

// The only valid run triggers (§12). schedule = the clock; manual = admin run-now;
// maintenance = trusted internal code. No agent-reachable trigger exists.
export type CuratorTrigger = "schedule" | "manual" | "maintenance";

// A run still "running" past this age is treated as a crashed-worker lock and
// reclaimed. Set well above the worst-case run time so a live run is never
// reclaimed; with a serial single-process tick, reclaim only fires after a crash.
const DEFAULT_LOCK_TTL_MS = 60 * 60_000; // 60 minutes

export interface RunDueCurationOptions {
  store: LibrarianStore;
  now: Date;
  schedule: ScheduleConfig;
  llmClient: LlmClient;
  /** Curator actor for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  policy: ApplyPolicy;
  promptAddendum?: string;
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

  const due = selectDueSlices(store.db, options.schedule, now);
  summary.due = due.length;

  for (const { slice } of due) {
    // One slice's failure (store error etc.) must not abort the whole batch.
    try {
      const lock = findRunningRun(store.db, slice);
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
