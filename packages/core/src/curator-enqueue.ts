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
// The "running" run row IS the lock. This is safe for the v1 single-process
// scheduler; true multi-process atomic locking (conditional insert / advisory
// lock) is a documented hardening follow-up. The LLM client is injected, so the
// loop is testable without network. The server-side tick calls this on a timer;
// admin run-now calls it with a manual trigger that bypasses the input-hash skip.

import { type ApplyPolicy } from "./curator-apply-policy.js";
import type { LlmClient } from "./curator-llm-client.js";
import type { ScheduleConfig } from "./curator-schedule.js";
import { findRunningRun, selectDueSlices } from "./curator-scheduler.js";
import type { RunCurationCaps } from "./curator-worker.js";
import { runCuration } from "./curator-worker.js";
import type { LibrarianStore } from "./store/librarian-store.js";

const DEFAULT_LOCK_TTL_MS = 30 * 60_000; // 30 minutes

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
  /** "schedule" | "manual" | "maintenance". Default "schedule". */
  trigger?: string;
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
  };

  const due = selectDueSlices(store.db, options.schedule, now);
  summary.due = due.length;

  for (const { slice } of due) {
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
  }

  return summary;
}
