// Claude `Stop` adapter — the orchestrator (testable; the hook entry is a thin
// shell over `runCapture`). Spec 2026-06-16-harness-auto-capture, T3.
//
// Wires the pure transforms (transcript.mjs), the durable cursor (cursor.mjs),
// and the network ship (post.mjs) into the one decision the `Stop` hook makes:
// since this session was last seen, ship the new NON-PRIVATE turns and advance
// the cursor ONLY on a server ack. Everything is fail-soft (Q6: err toward NOT
// capturing) — every path resolves, never throws; an error logs to the sidecar
// and the cursor stays put so the delta re-ships next run (idempotent; the
// server/curator dedup).
//
// The network `post` is INJECTED so the orchestration is unit-testable without a
// socket; the hook entry passes the real `postDelta`.

import fs from "node:fs";
import path from "node:path";
import { cursorPath, pruneOldCursors, readCursor, writeCursor } from "./cursor.mjs";
import { deriveTranscriptUrl, postDelta } from "./post.mjs";
import { buildPayload, entriesToTurns, filterPrivateSpans, parseEntries } from "./transcript.mjs";

const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ~7 days (Q5: age-based, never clear-all)

/**
 * Resolve the plugin data dir (cursor + sidecar-log home). Q5 default:
 * `${CLAUDE_PLUGIN_DATA:-$HOME/.librarian/claude-plugin-data}`.
 */
export function resolveDataDir(env) {
  const explicit = env.CLAUDE_PLUGIN_DATA;
  if (explicit && explicit.trim()) return explicit;
  const home = env.HOME || env.USERPROFILE || ".";
  return path.join(home, ".librarian", "claude-plugin-data");
}

/**
 * Append a one-line skip/error record to the local sidecar log (fail-soft, never
 * a stack trace into the model's context — AGENTS.md). Best-effort: a logging
 * failure is itself swallowed. NEVER logs turn text or the token.
 */
function logSidecar(dataDir, sessionId, message) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = `${new Date().toISOString()} [${sessionId ?? "?"}] ${message}\n`;
    fs.appendFileSync(path.join(dataDir, "capture.log"), line, "utf8");
  } catch {
    // last-resort: drop it. A log failure must never break the hook.
  }
}

/**
 * Is this Stop the end of the session (vs a mid-conversation turn stop)? Claude
 * fires `Stop` per turn-end; a true session end (close / `/clear`) surfaces as a
 * `SessionEnd` event name (when wired) — treat that as the explicit-end
 * accelerator (`ended:true`). Absent that signal, `ended` is omitted and the
 * server's idle settle-sweep handles it (spec §4.4 / SC3). Defensive across the
 * exact field name the harness uses.
 */
function isSessionEnd(hook) {
  const name = hook.hook_event_name || hook.hookEventName;
  return name === "SessionEnd" || name === "Stop:end";
}

/**
 * Run one capture pass for a `Stop` hook invocation.
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
  const sessionId = hook.session_id;

  // SUBAGENT SKIP (§6): an `agent_id`-present Stop is a subagent's; only the
  // top-level session is captured. No-op, no cursor touched.
  if (hook.agent_id) {
    return { posted: false, skipped: "subagent" };
  }

  // Age-based cursor pruning (Q5 / SC15) — opportunistic, fail-soft, NEVER
  // clear-all (a fresh sibling cursor is a live concurrent session).
  pruneOldCursors(dataDir, PRUNE_MAX_AGE_MS);

  try {
    if (!sessionId) {
      logSidecar(dataDir, sessionId, "skip: no session_id on hook input");
      return { posted: false, skipped: "no-session" };
    }

    // CONFIG (fail-soft, Q6 transient): without a URL + token there is nowhere to
    // ship — a clean no-op, cursor untouched, re-ships once configured.
    const url = deriveTranscriptUrl(env.LIBRARIAN_MCP_URL);
    const token = env.LIBRARIAN_AGENT_TOKEN;
    if (!url || !token) {
      logSidecar(dataDir, sessionId, "skip: LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN not set");
      return { posted: false, skipped: "not-configured" };
    }

    // READ TRANSCRIPT from the cursor offset to EOF (the new bytes since last run).
    const transcriptPath = hook.transcript_path;
    if (!transcriptPath) {
      logSidecar(dataDir, sessionId, "skip: no transcript_path on hook input");
      return { posted: false, skipped: "no-transcript" };
    }

    let size;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      logSidecar(dataDir, sessionId, "skip: transcript_path unreadable (stat failed)");
      return { posted: false, skipped: "no-transcript" };
    }

    const prior = readCursor(dataDir, sessionId);
    // The transcript is append-only (§6). If it shrank (rotation / a different
    // file reused the id), the offset is stale — restart from 0 (re-ship is safe).
    const start = prior.offset <= size ? prior.offset : 0;

    let chunk = "";
    if (size > start) {
      let fd;
      try {
        fd = fs.openSync(transcriptPath, "r");
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        chunk = buf.toString("utf8");
      } catch {
        logSidecar(dataDir, sessionId, "skip: transcript read failed");
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

    // PARSE → turns → PRIVATE-SPAN FILTER (forward-only). The cursor advances to
    // EOF regardless of whether anything was kept (skip-and-advance, Q6) — but
    // ONLY after a successful ship of the kept turns (or when there is nothing to
    // ship). Private state is carried forward across runs.
    const allTurns = entriesToTurns(parseEntries(chunk));
    const { kept, endPrivate } = filterPrivateSpans(allTurns, { startPrivate: prior.private });

    const ended = isSessionEnd(hook);

    // Nothing public to ship. Still advance the cursor past what we read (private
    // turns are now behind it — NEVER retroactively shipped, SC4) and persist the
    // carried private state. If the conversation ended we still want the server to
    // know (a private-only tail shouldn't strand the buffer), so send an
    // ended-only empty delta in that case; otherwise it's a pure no-op.
    if (kept.length === 0 && !ended) {
      writeCursor(dataDir, sessionId, { offset: size, seq: prior.seq, private: endPrivate });
      return { posted: false, skipped: "no-new-turns" };
    }

    const seq = prior.seq + 1;
    const payload = buildPayload({ sessionId, seq, turns: kept, ended });

    // SHIP. A non-2xx (`ok:false`) or a thrown network error → DO NOT advance the
    // cursor: the delta re-ships next run (idempotent; server/curator dedup). A
    // 2xx → advance past everything we read (including the private turns we
    // skipped) and persist the new seq + private state.
    let ack;
    try {
      ack = await post(url, payload, token);
    } catch (error) {
      // Transient/infra (Q6 skip-and-retry): log + leave the cursor. Never leak a
      // stack trace into the model context.
      logSidecar(
        dataDir,
        sessionId,
        `ship failed (transient, will retry): ${(error && error.message) || "network error"}`,
      );
      return { posted: false, skipped: "post-failed" };
    }

    if (!ack || !ack.ok) {
      logSidecar(
        dataDir,
        sessionId,
        `ship not acked (status ${ack ? ack.status : "?"}); cursor held, will retry`,
      );
      return { posted: false, skipped: "not-acked", ack };
    }

    // ACKED → advance.
    writeCursor(dataDir, sessionId, { offset: size, seq, private: endPrivate });
    return { posted: true, ack };
  } catch (error) {
    // Last-resort fail-soft: any unexpected error logs to the sidecar and exits a
    // no-op. The cursor is untouched on this path (no writeCursor reached), so the
    // delta re-ships next run.
    logSidecar(
      dataDir,
      sessionId,
      `unexpected error (no-op, fail-soft): ${(error && error.message) || "unknown"}`,
    );
    return { posted: false, skipped: "error" };
  }
}

// Re-export the cursor path helper so the hook entry / diagnostics can locate a
// session's cursor without reaching into cursor.mjs.
export { cursorPath };
