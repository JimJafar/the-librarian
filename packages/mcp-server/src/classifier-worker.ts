// Async classifier worker — drains the `classified = 0` projection
// queue. Single instance per mcp-server process; spec §4.1 + plan
// Task 4.5.
//
// Section 4a ships the worker module + tests but does NOT wire it into
// the mcp-server startup (the runtime stays inert until 4d). Existing
// memories continue to land via the legacy `deriveLegacyMemoryFlags`
// path; no code path writes `classified = 0` yet, so the worker has
// nothing to do in production until the cutover ships.
//
// State machine per row (spec §4.1):
//
//   classified=0           classifier ok?              attempts ≥ 3?
//   attempts=0          ─ yes ──▶ classified=1     ─ yes ──▶ classified=1
//   (row written)                  + verdict booleans          + conservative
//                                  + memory.classified         + memory.classified
//                       ─ no  ──▶ attempts++                   + fallback=max_retries
//                                  classified=0
//
// A crash mid-classification leaves the row at `classified=0` for the
// next iteration (no partial state to repair — the verdict is only
// written on success, the attempt counter is only incremented on a
// caught failure).

import type { DatabaseSync } from "node:sqlite";
import type { Classifier, ClassifyResult, ClassifierFallbackReason } from "@librarian/classifier";
import { CONSERVATIVE_DEFAULTS } from "@librarian/classifier";

/** Conservative-default attempts cap — spec §4.1. */
export const MAX_ATTEMPTS = 3;

/** Idle poll cadence in ms — spec §4.1 worker pacing. */
export const IDLE_POLL_MS = 500;

/** Result of one drain iteration. */
export type ProcessOutcome =
  | "processed"
  | "max_retries_giveup"
  | "attempt_failed"
  | "idle"
  | "error";

interface MemoryRow {
  id: string;
  title: string;
  body: string;
  tags_json: string;
  agent_id: string | null;
  classification_attempts: number;
  created_at: string;
}

export interface ClassifierWorkerDeps {
  /** SQLite handle (the same connection the projection writes through). */
  db: DatabaseSync;
  classifier: Classifier;
  /** Emit a memory ledger event (the wider store's `appendEvent`). */
  appendEvent: (
    eventType: string,
    payload: Record<string, unknown>,
    options?: { memory_id?: string; agent_id?: string },
  ) => void;
  /** Optional sidecar logger. Stays silent when omitted. */
  log?: (entry: Record<string, unknown>) => void;
  /** Optional clock seam for queue-wait measurement. Defaults to Date.now. */
  now?: () => number;
  /**
   * Optional setTimeout seam — tests pass a deterministic scheduler.
   * Defaults to the real `setTimeout`.
   */
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ClassifierWorker {
  /** Process at most one row; returns the outcome for that row. */
  processOnce(): Promise<ProcessOutcome>;
  /**
   * Start the polling loop. Resolves immediately; the loop runs in
   * the background until `stop()` is called.
   */
  start(): void;
  /** Stop the polling loop. Resolves once any in-flight iteration ends. */
  stop(): Promise<void>;
  /** True while `start()` has been called and `stop()` has not yet resolved. */
  readonly running: boolean;
}

export function createClassifierWorker(deps: ClassifierWorkerDeps): ClassifierWorker {
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
  const clearTimeoutFn =
    deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let running = false;
  let stopping: Promise<void> | null = null;
  let resolveStop: (() => void) | null = null;
  let scheduledHandle: unknown = null;
  // Tracks whether `tick()` is mid-await on `processOnce()`. `stop()`
  // must wait for this to clear before resolving — otherwise the
  // in-flight iteration can still `writeVerdictStmt.run(...)` /
  // `appendEvent(...)` after the caller closed the DB / log handle.
  let iterationInFlight = false;

  const selectStmt = deps.db.prepare(
    "SELECT id, title, body, tags_json, agent_id, classification_attempts, created_at " +
      "FROM memories WHERE classified = 0 ORDER BY created_at LIMIT 1",
  );
  const incrementStmt = deps.db.prepare(
    "UPDATE memories SET classification_attempts = classification_attempts + 1 WHERE id = ?",
  );
  // The status promotion only fires when the row is currently `proposed`
  // (the default landing state for pendingClassification writes). Other
  // statuses — active, archived — are preserved verbatim; the worker is
  // not the right surface to demote an already-published memory.
  const writeVerdictStmt = deps.db.prepare(
    "UPDATE memories SET classified = 1, is_global = ?, requires_approval = ?, " +
      "status = CASE WHEN status = 'proposed' AND ? = 0 THEN 'active' ELSE status END " +
      "WHERE id = ?",
  );

  async function processOnce(): Promise<ProcessOutcome> {
    const row = selectStmt.get() as MemoryRow | undefined;
    if (!row) return "idle";

    const queueStart = parseTimestamp(row.created_at);
    const beforeClassify = now();
    const tags = parseTags(row.tags_json);

    let result: ClassifyResult;
    try {
      result = await deps.classifier.classify({
        title: row.title,
        body: row.body,
        tags,
      });
    } catch (err) {
      // The classifier contract is fail-soft (every error path collapses
      // to a `fallback_used` verdict), so we should never get here —
      // but if a custom Classifier impl breaks the contract, do the
      // safe thing: count as a failed attempt and let the retry cap
      // catch it.
      //
      // Only log the error CLASS, never the message: a custom transport
      // could surface a bearer token inside the thrown error. The
      // remote provider (the only first-party impl) folds errors to
      // a typed fallback before they reach here, so we're already
      // belt-and-braces; redacting the message keeps that property
      // intact for third-party impls.
      incrementStmt.run(row.id);
      const attempts = row.classification_attempts + 1;
      const errorClass =
        err instanceof Error
          ? err.constructor.name
          : typeof err === "object"
            ? "object"
            : typeof err;
      deps.log?.({
        event: "classifier-worker",
        outcome: "classify_threw",
        memory_id: row.id,
        attempts,
        error_class: errorClass,
      });
      if (attempts >= MAX_ATTEMPTS) {
        giveUp(row, queueStart, beforeClassify, attempts, tags);
        return "max_retries_giveup";
      }
      return "attempt_failed";
    }

    // `now()` is `Date.now` by default (integer ms), but a custom seam
    // could supply `performance.now()` — the event schema requires
    // `z.number().int()`, so round at the emission boundary.
    const inferenceMs = Math.max(0, Math.round(now() - beforeClassify));
    const queueWaitMs = Number.isFinite(queueStart)
      ? Math.max(0, Math.round(beforeClassify - queueStart))
      : 0;

    if (result.fallback_used) {
      // A fallback verdict means the model failed (parse / timeout /
      // provider error). Count the attempt and decide whether to give up.
      incrementStmt.run(row.id);
      const attempts = row.classification_attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        finalize(row, {
          verdict: CONSERVATIVE_DEFAULTS,
          fallback_used: "max_retries",
          provider: result.provider,
          model: result.model,
          prompt_version: result.prompt_version,
          rawOutput: result.raw_output,
          parsed: null,
          inferenceMs,
          queueWaitMs,
          attemptNumber: attempts,
          tags,
        });
        return "max_retries_giveup";
      }
      // Keep the row at classified=0 for the next iteration.
      deps.log?.({
        event: "classifier-worker",
        outcome: "attempt_failed",
        memory_id: row.id,
        attempts,
        fallback_used: result.fallback_used,
      });
      return "attempt_failed";
    }

    // Success: write the verdict + emit the event.
    // `attemptNumber` is the attempt index that succeeded, 1-indexed:
    // a first-try success is `1`, not `0`. Aligns with the spec §4.8
    // `attempt_number` field semantics.
    finalize(row, {
      verdict: result.verdict,
      fallback_used: false,
      provider: result.provider,
      model: result.model,
      prompt_version: result.prompt_version,
      rawOutput: result.raw_output,
      parsed: result.verdict,
      inferenceMs,
      queueWaitMs,
      attemptNumber: row.classification_attempts + 1,
      tags,
    });
    return "processed";
  }

  function start(): void {
    if (running) return;
    running = true;
    stopping = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    void schedule(0);
  }

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;
    if (scheduledHandle !== null) {
      clearTimeoutFn(scheduledHandle);
      scheduledHandle = null;
    }
    if (stopping) {
      const promise = stopping;
      // Only resolve immediately when no iteration is mid-flight; if
      // one is, `tick()`'s exit path will resolve via `resolveStop`
      // when it observes `running === false`.
      if (!iterationInFlight) {
        resolveStop?.();
        resolveStop = null;
        stopping = null;
      }
      await promise;
    }
  }

  async function tick(): Promise<void> {
    if (!running) return;
    iterationInFlight = true;
    let outcome: ProcessOutcome = "idle";
    try {
      outcome = await processOnce();
    } catch (err) {
      deps.log?.({
        event: "classifier-worker",
        outcome: "tick_threw",
        error: err instanceof Error ? err.message : String(err),
      });
      outcome = "error";
    } finally {
      iterationInFlight = false;
    }
    if (!running) {
      // We were asked to stop while in flight; finalise the stopping
      // promise so the caller's `await stop()` returns only after the
      // DB / event-append calls in this iteration have finished.
      resolveStop?.();
      resolveStop = null;
      stopping = null;
      return;
    }
    // Busy: process the next row immediately. Idle/error: back off.
    const delay = outcome === "idle" || outcome === "error" ? IDLE_POLL_MS : 0;
    void schedule(delay);
  }

  function schedule(ms: number): void {
    if (!running) return;
    scheduledHandle = setTimeoutFn(() => {
      scheduledHandle = null;
      void tick();
    }, ms);
  }

  function finalize(
    row: MemoryRow,
    args: {
      verdict: { requires_approval: boolean; is_global: boolean };
      fallback_used: false | ClassifierFallbackReason;
      provider: "remote" | "none";
      model: string;
      prompt_version: string;
      rawOutput: string;
      parsed: { requires_approval: boolean; is_global: boolean } | null;
      inferenceMs: number;
      queueWaitMs: number;
      attemptNumber: number;
      tags: string[];
    },
  ): void {
    // Positional bind order for writeVerdictStmt (load-bearing — the
    // CASE expression references its own copy of `requires_approval`):
    //
    //   1. is_global         → SET is_global = ?
    //   2. requires_approval → SET requires_approval = ?
    //   3. requires_approval → CASE … AND ? = 0 THEN 'active' …
    //   4. id                → WHERE id = ?
    //
    // node:sqlite supports named parameters but the rest of the worker
    // uses positional binding; sticking with positional keeps the
    // surrounding style consistent.
    const isGlobalParam = args.verdict.is_global ? 1 : 0;
    const requiresApprovalParam = args.verdict.requires_approval ? 1 : 0;
    writeVerdictStmt.run(isGlobalParam, requiresApprovalParam, requiresApprovalParam, row.id);
    const payload: Record<string, unknown> = {
      memory_id: row.id,
      agent_id: row.agent_id ?? "system",
      input: { title: row.title, body: row.body, tags: args.tags },
      provider: args.provider,
      model: args.model,
      prompt_version: args.prompt_version,
      raw_output: args.rawOutput,
      parsed: args.parsed,
      queue_wait_ms: args.queueWaitMs,
      inference_ms: args.inferenceMs,
      attempt_number: args.attemptNumber,
    };
    if (args.fallback_used !== false) payload.fallback_used = args.fallback_used;
    const opts: { memory_id?: string; agent_id?: string } = { memory_id: row.id };
    if (row.agent_id !== null) opts.agent_id = row.agent_id;
    deps.appendEvent("memory.classified", payload, opts);
  }

  function giveUp(
    row: MemoryRow,
    queueStart: number,
    beforeClassify: number,
    attempts: number,
    tags: string[],
  ): void {
    finalize(row, {
      verdict: CONSERVATIVE_DEFAULTS,
      fallback_used: "max_retries",
      provider: "none",
      model: "(none)",
      prompt_version: "(none)",
      rawOutput: "",
      parsed: null,
      inferenceMs: Math.max(0, Math.round(now() - beforeClassify)),
      queueWaitMs: Number.isFinite(queueStart)
        ? Math.max(0, Math.round(beforeClassify - queueStart))
        : 0,
      attemptNumber: attempts,
      tags,
    });
  }

  return {
    processOnce,
    start,
    stop,
    get running() {
      return running;
    },
  };
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson);
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    /* fall through */
  }
  return [];
}

function parseTimestamp(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.NaN;
}
