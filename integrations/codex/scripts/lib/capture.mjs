// Codex auto-capture adapter — the orchestrator (testable; the hook entry is a
// thin shell over `runCapture`). Spec 2026-06-16-harness-auto-capture, Phase 2A.
//
// Mirrors the Claude orchestrator (integrations/claude/scripts/lib/capture.mjs):
// since this conversation was last seen, ship the new NON-PRIVATE turns and
// advance the cursor ONLY on a server ack. Everything is fail-soft — every path
// resolves, never throws; an error logs to the sidecar and the cursor stays put
// so the delta re-ships next run (idempotent; server/curator dedup).
//
// Codex-specific differences from the Claude orchestrator:
//   1. conv_id is DERIVED (transcript.deriveConvId): a stable hook `session_id`,
//      else the transcript filename, else NULL → clean no-op. NEVER $USER/cwd
//      (spec §4.11) — mem0's Codex scripts key by `$USER`, the collision bug we
//      explicitly avoid. The cursor + server buffer are keyed by this conv_id.
//   2. The `LIBRARIAN_AUTO_SAVE=false` per-machine kill-switch is enforced HERE
//      as a hard gate (ship nothing, buffer nothing — slash-commands.md contract).
//      Codex has no SessionStart awareness banner in the mem0-style wiring, so the
//      kill-switch is honored in the capture path itself, not just surfaced.
//
// ── ASSUMED CODEX HOOK PAYLOAD (the one genuine unknown) ────────────────────
// No `codex` CLI exists on the build machine to confirm a live turn, so the hook
// fields below (`session_id`, `transcript_path`, `cwd`, `agent_id`,
// `hook_event_name`) are DERIVED from mem0's PROVEN Codex hook scripts + the
// Claude payload (see transcript.mjs for the full provenance note). SC1 (a true
// e2e turn against a running Codex) is DEFERRED/unverified; the capture+post path
// is satisfied at the unit + live-LOCAL-server contract level.
//
// The network `post` is INJECTED so the orchestration is unit-testable without a
// socket; the hook entry passes the real `postDelta`.

import fs from "node:fs";
import path from "node:path";
import { cursorPath, pruneOldCursors, readCursor, writeCursor } from "./cursor.mjs";
import { deriveTranscriptUrl, postDelta } from "./post.mjs";
import {
  buildPayload,
  completeLineBytes,
  deriveConvId,
  entriesToTurns,
  filterPrivateSpans,
  parseEntries,
} from "./transcript.mjs";

const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ~7 days (age-based, never clear-all)

// Per-run client ship cap. The cursor advances at most this many bytes per hook,
// to a precise LINE boundary inside the window: (1) a first capture of a multi-MB
// session must NOT POST a body over the server's maxBodyBytes (1 MiB default) — a
// 413 would hold the cursor and re-ship forever (livelock); (2) a large backlog
// drains over multiple hook firings, a bounded chunk each run.
const MAX_SHIP_BYTES = 256 * 1024; // 256 KiB — safely under the 1 MiB server cap

/**
 * Resolve the plugin data dir (cursor + sidecar-log home):
 * `${CODEX_PLUGIN_DATA:-$HOME/.librarian/codex-plugin-data}`.
 */
export function resolveDataDir(env) {
  const explicit = env.CODEX_PLUGIN_DATA;
  if (explicit && explicit.trim()) return explicit;
  const home = env.HOME || env.USERPROFILE || ".";
  return path.join(home, ".librarian", "codex-plugin-data");
}

/**
 * Is the local auto-save kill-switch OFF? True ONLY for the exact string "false"
 * (case-insensitive); anything else (unset, "", "true", …) is default-ON
 * (slash-commands.md "two gates"). Pure + total.
 */
export function isAutoSaveOff(env) {
  const v = env && env.LIBRARIAN_AUTO_SAVE;
  return typeof v === "string" && v.trim().toLowerCase() === "false";
}

/**
 * Append a one-line skip/error record to the local sidecar log (fail-soft, never
 * a stack trace into the model's context). Best-effort. NEVER logs turn text or
 * the token.
 */
function logSidecar(dataDir, convId, message) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = `${new Date().toISOString()} [${convId ?? "?"}] ${message}\n`;
    fs.appendFileSync(path.join(dataDir, "capture.log"), line, "utf8");
  } catch {
    // last-resort: drop it. A log failure must never break the hook.
  }
}

/**
 * Is this the end of the conversation (vs a mid-conversation turn)? A true end
 * (close / `/clear`) surfaces as a `SessionEnd` event name — treat that as the
 * explicit-end accelerator (`ended:true`). Absent it, `ended` is omitted and the
 * server's idle settle-sweep handles timing. Defensive across the exact field name.
 */
function isSessionEnd(hook) {
  const name = hook.hook_event_name || hook.hookEventName;
  return name === "SessionEnd";
}

/**
 * Run one capture pass for a Codex hook invocation.
 *
 * @param {{transcript_path?:string, session_id?:string, agent_id?:string,
 *          cwd?:string, hook_event_name?:string}} hook - the parsed hook JSON.
 * @param {Record<string,string|undefined>} env - process env (URL, token, data dir).
 * @param {{post?: typeof postDelta}} [deps] - injectable network ship (tests).
 * @returns {Promise<{posted:boolean, skipped?:string,
 *          ack?:{ok:boolean,status:number,buffered?:number}}>}
 */
export async function runCapture(hook, env, deps = {}) {
  const post = deps.post ?? postDelta;
  const dataDir = resolveDataDir(env);

  // conv_id FIRST — it keys the cursor + the server buffer, and a missing id is a
  // clean no-op (NEVER cwd/$USER). Resolved before any state is touched.
  const convId = deriveConvId(hook);

  // SUBAGENT SKIP: an `agent_id`-present hook is a subagent's; only the top-level
  // conversation is captured. No-op, no cursor touched (mirrors mem0's on_stop).
  if (hook.agent_id) {
    return { posted: false, skipped: "subagent" };
  }

  // KILL-SWITCH (slash-commands.md, SC4): LIBRARIAN_AUTO_SAVE=false ships nothing
  // and buffers nothing on this machine. Hard gate — checked before any IO so a
  // disabled machine never reads a transcript or writes a cursor.
  if (isAutoSaveOff(env)) {
    return { posted: false, skipped: "auto-save-off" };
  }

  // Age-based cursor pruning — opportunistic, fail-soft, NEVER clear-all.
  pruneOldCursors(dataDir, PRUNE_MAX_AGE_MS);

  try {
    if (!convId) {
      logSidecar(dataDir, convId, "skip: no stable conv_id (no session_id / transcript_path)");
      return { posted: false, skipped: "no-conv-id" };
    }

    // CONFIG (fail-soft): without a URL + token there is nowhere to ship — a clean
    // no-op, cursor untouched, re-ships once configured.
    const url = deriveTranscriptUrl(env.LIBRARIAN_MCP_URL);
    const token = env.LIBRARIAN_AGENT_TOKEN;
    if (!url || !token) {
      logSidecar(dataDir, convId, "skip: LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN not set");
      return { posted: false, skipped: "not-configured" };
    }

    const transcriptPath = hook.transcript_path;
    if (!transcriptPath) {
      logSidecar(dataDir, convId, "skip: no transcript_path on hook input");
      return { posted: false, skipped: "no-transcript" };
    }

    let size;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      logSidecar(dataDir, convId, "skip: transcript_path unreadable (stat failed)");
      return { posted: false, skipped: "no-transcript" };
    }

    const prior = readCursor(dataDir, convId);
    // The transcript is append-only. If it shrank (rotation / a reused id), the
    // offset is stale — restart from 0 (re-ship is safe).
    const start = prior.offset <= size ? prior.offset : 0;

    // READ A BOUNDED WINDOW from the cursor: at most MAX_SHIP_BYTES so a huge first
    // delta never POSTs a body over the server cap (no 413 livelock), and a large
    // backlog drains over multiple firings. We slice to a precise LINE boundary so
    // a half-flushed trailing line (a hook firing mid-write) is never lost/torn.
    let buf = Buffer.alloc(0);
    const readLen = Math.min(size - start, MAX_SHIP_BYTES);
    if (readLen > 0) {
      let fd;
      try {
        fd = fs.openSync(transcriptPath, "r");
        buf = Buffer.alloc(readLen);
        const bytesRead = fs.readSync(fd, buf, 0, readLen, start);
        if (bytesRead < readLen) buf = buf.subarray(0, bytesRead);
      } catch {
        logSidecar(dataDir, convId, "skip: transcript read failed");
        return { posted: false, skipped: "no-transcript" };
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    }

    // BYTE-ACCURATE LINE BOUNDARY. `consumed` is one past the last `\n`: everything
    // before it is whole JSON lines; a trailing partial line stays unread.
    const consumed = completeLineBytes(buf);

    // PATHOLOGICAL: a full window with NO newline is one giant line longer than
    // MAX_SHIP_BYTES. We can never ship it; only when the window is FULL do we
    // skip-and-advance past it so the cursor still progresses (never livelock).
    const windowIsFull = readLen === MAX_SHIP_BYTES && buf.length === MAX_SHIP_BYTES;
    if (consumed === 0 && windowIsFull) {
      logSidecar(
        dataDir,
        convId,
        `skip: a single line exceeds MAX_SHIP_BYTES (${MAX_SHIP_BYTES}); advancing past the window to avoid livelock`,
      );
      writeCursor(dataDir, convId, {
        offset: start + buf.length,
        seq: prior.seq,
        private: prior.private,
      });
      return { posted: false, skipped: "oversized-line" };
    }

    const completeBytes = buf.subarray(0, consumed);
    const chunk = completeBytes.toString("utf8");
    const nextOffset = start + consumed;

    // PARSE → turns → PRIVATE-SPAN FILTER (forward-only). The cursor advances over
    // the complete-line prefix regardless of whether anything was kept — but ONLY
    // after a successful ship of the kept turns (or when nothing is to ship).
    const allTurns = entriesToTurns(parseEntries(chunk));
    const { kept, endPrivate } = filterPrivateSpans(allTurns, { startPrivate: prior.private });

    // Only the FINAL, file-tail-reaching window can mark the conversation `ended`.
    const drainedToEof = nextOffset >= size;
    const ended = isSessionEnd(hook) && drainedToEof;

    // Nothing public to ship in this window. Advance the cursor past the complete
    // lines we read (private turns now behind it — NEVER retroactively shipped) and
    // persist the carried private state. If the conversation ended AND we reached
    // EOF, still send an ended-only empty delta so a private-only tail doesn't
    // strand the buffer; otherwise it's a no-op for this window.
    if (kept.length === 0 && !ended) {
      writeCursor(dataDir, convId, { offset: nextOffset, seq: prior.seq, private: endPrivate });
      return { posted: false, skipped: "no-new-turns" };
    }

    const seq = prior.seq + 1;
    const payload = buildPayload({ convId, seq, turns: kept, ended });

    // SHIP. A non-2xx (`ok:false`) or a thrown network error → DO NOT advance the
    // cursor: the delta re-ships next run (idempotent; server/curator dedup). A
    // 2xx → advance past everything we read and persist the new seq + private state.
    let ack;
    try {
      ack = await post(url, payload, token);
    } catch (error) {
      logSidecar(
        dataDir,
        convId,
        `ship failed (transient, will retry): ${(error && error.message) || "network error"}`,
      );
      return { posted: false, skipped: "post-failed" };
    }

    if (!ack || !ack.ok) {
      logSidecar(
        dataDir,
        convId,
        `ship not acked (status ${ack ? ack.status : "?"}); cursor held, will retry`,
      );
      return { posted: false, skipped: "not-acked", ack };
    }

    // ACKED → advance to the precise complete-line boundary (NOT raw EOF): a
    // trailing partial line stays unread, and a backlog drains over more runs.
    writeCursor(dataDir, convId, { offset: nextOffset, seq, private: endPrivate });
    return { posted: true, ack };
  } catch (error) {
    // Last-resort fail-soft: any unexpected error logs to the sidecar and exits a
    // no-op. The cursor is untouched on this path, so the delta re-ships next run.
    logSidecar(
      dataDir,
      convId,
      `unexpected error (no-op, fail-soft): ${(error && error.message) || "unknown"}`,
    );
    return { posted: false, skipped: "error" };
  }
}

// Re-export the cursor path helper so the hook entry / diagnostics can locate a
// conversation's cursor without reaching into cursor.mjs.
export { cursorPath };
