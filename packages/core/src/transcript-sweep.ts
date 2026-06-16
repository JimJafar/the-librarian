// Transcript settle-sweep + buffer lifecycle (spec 2026-06-16-harness-auto-capture,
// T2). This is the EXTRACTION clock (spec §4.3): a background tick — wired into the
// server scheduler exactly like the intake / grooming / backup ticks — that scans
// `<dataDir>/transcripts/` for SETTLED buffers and turns each into inbox facts.
//
// The lifecycle for one buffer:
//   1. SETTLE-DETECT — a buffer is settled when any of:
//        - idle: mtime older than `idleMs` (LIBRARIAN_TRANSCRIPT_IDLE_MS, 30 min),
//        - explicit-end: an `<conv_id>.ended` marker exists (T1's `ended:true`),
//        - size: the buffer is over `maxBytes` (LIBRARIAN_TRANSCRIPT_MAX_BYTES) —
//          the runaway safety valve.
//   2. ATOMIC CLAIM — rename `<conv_id>.md` → `<conv_id>.processing` (atomic on
//      one filesystem). A straggler T1 delta then starts a FRESH `<conv_id>.md`
//      instead of racing the delete (T1 appends to the `.md`).
//   3. EXTRACT — ONE LLM pass over the claimed buffer → N candidate facts
//      (transcript-extract.ts), using the intake consumer's own LLM client.
//   4. SUBMIT — each fact INDIVIDUALLY to the EXISTING inbox via submitToInbox,
//      tagged (source=auto_capture, harness) so it flows through the UNCHANGED
//      navigate→judge→apply with confidence bands. The judge/apply is untouched.
//   5. DELETE-AFTER — drop the `.processing` claim (and any `.ended` marker) on
//      success: zero trace; only extracted facts persist in the inbox→vault path.
//
// REAPER — an orphaned `.processing` (crash mid-extract) is recovered at the
// START of each tick: a `.processing` older than `reaperTtlMs` is renamed back to
// `<conv_id>.md` so the same tick re-claims and re-extracts it. Mirrors the
// inbox's `releaseStaleClaims` boot-reaper.
//
// GATE COHERENCE (spec Q-gate, locked) — the WHOLE tick self-gates on
// isIntakeEnabled(store), the SAME gate T1's endpoint refuses on and the SAME
// gate the intake tick reads. Disabled → nothing extracted, buffers untouched
// (the intake tick that would drain the inbox is also off, so we never feed a
// dead pipeline). Buffers simply wait for the gate to come back on.
//
// FAIL-SOFT (AGENTS.md) — a sweep / LLM / parse failure must NEVER crash the
// worker or block anything. Every per-buffer step is wrapped: a throw on one
// buffer logs and the sweep moves on to the next. The tick resolves with a
// summary; it never rejects.

import fs from "node:fs";
import path from "node:path";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "./curator-consumers.js";
import { type LlmClient, createGroomingLlmClient } from "./grooming-llm-client.js";
import { isIntakeEnabled } from "./intake-config.js";
import type { LibrarianStore } from "./store/librarian-store.js";
import {
  endedMarkerPath,
  sanitizeConvId,
  transcriptBufferPath,
  transcriptProcessingPath,
  transcriptsDir,
} from "./transcript-buffer.js";
import { extractTranscriptFacts } from "./transcript-extract.js";

/** Idle window: a buffer untouched this long is settled (spec Q-settle = 30 min). */
export const DEFAULT_TRANSCRIPT_IDLE_MS = 30 * 60_000;
/** Runaway safety valve: a buffer over this size is settled regardless of idle. */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 5_000_000;
/** Reaper TTL: a `.processing` claim older than this is treated as a crashed worker. */
export const DEFAULT_TRANSCRIPT_REAPER_TTL_MS = 30 * 60_000;

export interface TranscriptSweepOptions {
  store: LibrarianStore;
  /** Idle window in ms; defaults to LIBRARIAN_TRANSCRIPT_IDLE_MS / 30 min. */
  idleMs?: number;
  /** Size cap in bytes; defaults to LIBRARIAN_TRANSCRIPT_MAX_BYTES / 5 MB. */
  maxBytes?: number;
  /** Stale-claim TTL for the `.processing` reaper; defaults to 30 min. */
  reaperTtlMs?: number;
  /** Clock (epoch ms) for settle/reaper math; defaults to Date.now. Mostly tests. */
  now?: () => number;
  /**
   * Injectable LLM client builder (defaults to the OpenAI-compatible client built
   * from the intake consumer config) — mirrors runIntakeTick's `buildClient`, so
   * tests inject a fake `complete` with no network.
   */
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
}

export interface TranscriptSweepSummary {
  /** Buffers that were claimed + extracted this tick (settled). */
  extracted: number;
  /** Total candidate facts submitted to the inbox across all extractions. */
  facts: number;
  /** Buffers seen but NOT settled (left for a later tick). */
  skipped: number;
  /** Orphaned `.processing` claims reaped (renamed back to `.md`) this tick. */
  reaped: number;
  /** Why the tick did nothing wholesale, when applicable. */
  reason?: "disabled" | "no_dir" | "no_client";
}

/** A logger shim so the worker stays free of the mcp-server logger import. */
type Warn = (info: Record<string, unknown>, msg: string) => void;

/**
 * Run ONE settle-sweep tick. Resolves with a summary; never rejects (fail-soft).
 * Self-gates on the intake gate first, then reaps orphaned claims, then extracts
 * every settled buffer.
 */
export async function runTranscriptSweepTick(
  options: TranscriptSweepOptions & { warn?: Warn },
): Promise<TranscriptSweepSummary> {
  const { store } = options;
  const warn: Warn = options.warn ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const idleMs = options.idleMs ?? DEFAULT_TRANSCRIPT_IDLE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES;
  const reaperTtlMs = options.reaperTtlMs ?? DEFAULT_TRANSCRIPT_REAPER_TTL_MS;

  const summary: TranscriptSweepSummary = { extracted: 0, facts: 0, skipped: 0, reaped: 0 };

  // GATE COHERENCE: the whole tick is gated on the intake gate that would drain
  // the inbox these facts land in (spec Q-gate). Disabled → leave every buffer
  // exactly where it is; it waits for the gate to come back on.
  if (!isIntakeEnabled(store)) {
    summary.reason = "disabled";
    return summary;
  }

  const dir = transcriptsDir(store.dataDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // No transcripts/ dir yet (nothing ever buffered) — a clean no-op.
    summary.reason = "no_dir";
    return summary;
  }

  // REAPER (run first): an orphaned `.processing` older than the TTL is a crashed
  // worker — rename it back to `<conv_id>.md` so THIS tick re-claims it below.
  for (const name of entries) {
    if (!name.endsWith(".processing")) continue;
    const procPath = path.join(dir, name);
    try {
      const stat = fs.statSync(procPath);
      if (now() - stat.mtimeMs < reaperTtlMs) continue; // a live, in-flight claim — leave it
      const recovered = procPath.replace(/\.processing$/, ".md");
      // If a fresh `<conv_id>.md` already exists (T1 started a new segment after
      // the claim), don't clobber it — drop the stale orphan instead.
      if (fs.existsSync(recovered)) {
        fs.rmSync(procPath, { force: true });
      } else {
        fs.renameSync(procPath, recovered);
      }
      summary.reaped += 1;
    } catch (err) {
      warn({ file: name, err: (err as Error).message }, "transcript reaper failed for a claim");
    }
  }

  // Re-list after reaping so reaped `<conv_id>.md` files are considered this tick.
  let buffers: string[];
  try {
    buffers = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    summary.reason = "no_dir";
    return summary;
  }
  if (buffers.length === 0) return summary;

  // Build the extractor LLM client ONCE per tick from the intake consumer config
  // (the sweep reuses the curator's existing client/config — spec T2). If the
  // config isn't operational, there is nothing to extract WITH: leave buffers be.
  const client = buildExtractorClient(store, options.buildClient, warn);
  if (!client) {
    summary.reason = "no_client";
    return summary;
  }

  for (const name of buffers) {
    const bufferPath = path.join(dir, name);
    // The conv_id base (already sanitized on disk by T1); used to derive sibling paths.
    const convBase = name.slice(0, -".md".length);
    try {
      const stat = fs.statSync(bufferPath);
      const ended = fs.existsSync(siblingMarker(dir, convBase));
      const idle = now() - stat.mtimeMs >= idleMs;
      const oversize = stat.size >= maxBytes;
      if (!ended && !idle && !oversize) {
        summary.skipped += 1;
        continue; // not settled yet — a later tick will revisit it
      }

      // ATOMIC CLAIM: rename to `.processing`. A straggler T1 delta then starts a
      // fresh `<conv_id>.md` (T1 appends to the `.md`), never racing the delete.
      const procPath = path.join(dir, `${convBase}.processing`);
      try {
        fs.renameSync(bufferPath, procPath);
      } catch (err) {
        // Lost the claim (a concurrent tick / a delete) — skip, no double-extract.
        warn({ file: name, err: (err as Error).message }, "transcript claim failed; skipping");
        continue;
      }

      summary.extracted += 1;
      const text = readClaimed(procPath, warn);
      const facts = text ? await extractTranscriptFacts(text, { llmClient: client }) : [];

      for (const fact of facts) {
        try {
          store.submitToInbox(fact, autoCaptureHints());
          summary.facts += 1;
        } catch (err) {
          // One fact failing to submit must not lose the others — log + move on.
          warn({ err: (err as Error).message }, "auto-capture inbox submit failed (fail-soft)");
        }
      }

      // DELETE-AFTER: drop the claim + any `.ended` marker. Zero trace; only the
      // extracted facts persist in the inbox→vault path.
      fs.rmSync(procPath, { force: true });
      fs.rmSync(siblingMarker(dir, convBase), { force: true });
    } catch (err) {
      // Per-buffer fail-soft: an unexpected error on one buffer never aborts the
      // rest of the sweep. The claim (if made) stays as `.processing` for the
      // reaper to retry next tick.
      warn({ file: name, err: (err as Error).message }, "transcript sweep failed for a buffer");
    }
  }

  return summary;
}

/** The `<conv_id>.ended` marker path for a conv base already on disk. */
function siblingMarker(dir: string, convBase: string): string {
  return path.join(dir, `${convBase}.ended`);
}

/** Read a claimed buffer's text; fail-soft to "" so a read error is a no-fact extract. */
function readClaimed(procPath: string, warn: Warn): string {
  try {
    return fs.readFileSync(procPath, "utf8");
  } catch (err) {
    warn({ err: (err as Error).message }, "transcript claim read failed (fail-soft)");
    return "";
  }
}

/**
 * Hints stamped on every auto-captured candidate fact (spec T2): a `source` /
 * harness tag so the provenance is visible in the inbox and on the resulting
 * memory. (The Claude adapter's per-entry gitBranch is a T3 concern and rides in
 * the buffer; v1 tags the source + harness here.)
 */
function autoCaptureHints(): { tags: string[] } {
  return { tags: ["auto_capture", "source:auto_capture"] };
}

/**
 * Build the extractor's LLM client from the intake consumer config — the SAME
 * provider/model/token the intake judge uses (spec T2: reuse the curator's
 * client). Returns null when the config isn't operational or the token can't be
 * decrypted; the caller then leaves buffers for a later tick. Honours an injected
 * builder (tests) exactly like runIntakeTick.
 */
function buildExtractorClient(
  store: LibrarianStore,
  inject: TranscriptSweepOptions["buildClient"],
  warn: Warn,
): LlmClient | null {
  try {
    migrateLegacyCuratorLlm(store);
    const llm = readConsumerConfig(store, "intake");
    if (!llm.isOperational) return null;
    let token: string | null;
    try {
      token = resolveConsumerToken(store, "intake");
    } catch {
      return null;
    }
    if (!token) return null;
    const build =
      inject ??
      ((conn, secret) =>
        createGroomingLlmClient({
          endpoint: conn.endpoint,
          token: secret,
          model: conn.model,
          timeoutMs: conn.timeoutMs,
        }));
    return build({ endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs }, token);
  } catch (err) {
    warn({ err: (err as Error).message }, "transcript extractor client build failed (fail-soft)");
    return null;
  }
}

// Re-export the path helpers so the buffer-path contract has ONE import surface
// for the sweep's consumers (the scheduler wiring + tests). They live in
// transcript-buffer.ts (shared with the T1 ingestion half).
export {
  endedMarkerPath,
  sanitizeConvId,
  transcriptBufferPath,
  transcriptProcessingPath,
  transcriptsDir,
};
