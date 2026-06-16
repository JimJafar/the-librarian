// Claude `Stop` adapter — the per-session byte-offset cursor (pure-ish, testable).
// Spec 2026-06-16-harness-auto-capture, T3 (resolves Q-cursor-home = §5 #5).
//
// The cursor is the adapter's only durable state. It records, PER SESSION:
//   - `offset`  : how many bytes of `<session_id>.jsonl` we have already shipped
//                 (or skipped-as-private). The next run reads from here to EOF.
//   - `seq`     : the adapter's monotonic delta counter for the contract payload.
//   - `private` : whether the previous run ended inside an open `[private=on]`
//                 span (carry-forward, Q4/Q6) — so an unterminated span stays
//                 private into the next run.
//
// Home (Q5): `${CLAUDE_PLUGIN_DATA:-$HOME/.librarian/claude-plugin-data}/cursors/
// <session_id>` — idiomatic persistent plugin state, survives reboot, namespaced
// for uninstall. The cursor is NON-CRITICAL: if lost, the hook re-ships from 0 and
// idempotency rests on the curator's fact-level dedup + advance-on-ack. So every
// read is fail-soft (a missing/corrupt cursor reads as a fresh start).
//
// Concurrency (SC15): keyed by `session_id` ONLY (never `$USER`/`cwd`), so N
// concurrent same-machine sessions get N distinct cursor files. Pruning is
// AGE-BASED — never "clear all" (that would clobber a live sibling session).

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the cursors directory under the plugin data dir. The data dir is the
 * caller's responsibility (it reads `CLAUDE_PLUGIN_DATA` / the default); we just
 * append `cursors/`.
 */
export function cursorsDir(dataDir) {
  return path.join(dataDir, "cursors");
}

/**
 * Reduce a `session_id` to a single safe path segment so a hostile/odd id can't
 * traverse out of `cursors/`. Claude session ids are UUIDs, but defense in depth
 * is cheap and mirrors the server's `sanitizeConvId`.
 */
function safeSegment(sessionId) {
  const cleaned = String(sessionId ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.\.+/g, "_") // collapse any `..` run — never a parent-dir reference
    .replace(/^\.+/, "_") // never a leading dot (no `.` / dotfiles)
    .slice(0, 200);
  return cleaned || "unknown";
}

/** Absolute path of a session's cursor file. */
export function cursorPath(dataDir, sessionId) {
  return path.join(cursorsDir(dataDir), safeSegment(sessionId));
}

/**
 * Read a session's cursor. Fail-soft: a missing or unparseable cursor reads as a
 * fresh start (`offset:0, seq:0, private:false`) — re-shipping is safe (the
 * server/curator dedup), so we never throw here.
 *
 * @returns {{offset:number, seq:number, private:boolean}}
 */
export function readCursor(dataDir, sessionId) {
  const fresh = { offset: 0, seq: 0, private: false };
  try {
    const raw = fs.readFileSync(cursorPath(dataDir, sessionId), "utf8");
    const parsed = JSON.parse(raw);
    return {
      offset: Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0,
      seq: Number.isInteger(parsed.seq) && parsed.seq >= 0 ? parsed.seq : 0,
      private: parsed.private === true,
    };
  } catch {
    return fresh;
  }
}

/**
 * Persist a session's cursor. Written atomically (tmp + rename) so a crash
 * mid-write can never leave a torn cursor that a concurrent run misreads.
 * Fail-soft: a write failure is swallowed (the caller already shipped; losing the
 * cursor only costs an idempotent re-ship next run).
 *
 * @param {{offset:number, seq:number, private:boolean}} state
 */
export function writeCursor(dataDir, sessionId, state) {
  try {
    const dir = cursorsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const target = cursorPath(dataDir, sessionId);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        offset: state.offset,
        seq: state.seq,
        private: Boolean(state.private),
      }),
      "utf8",
    );
    fs.renameSync(tmp, target);
  } catch {
    // Non-critical state; a lost cursor self-heals via re-ship + dedup.
  }
}

/**
 * Age-based pruning (SC15): drop cursor files whose mtime is older than
 * `maxAgeMs`. NEVER "clear all" — a fresh sibling cursor (a concurrently-running
 * session) must survive. Fail-soft: a missing dir or an un-stat-able file is
 * skipped, never thrown.
 *
 * @param {string} dataDir
 * @param {number} maxAgeMs - default ~7 days.
 */
export function pruneOldCursors(dataDir, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const dir = cursorsDir(dataDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no cursors dir yet — nothing to prune
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Race with a concurrent session writing/rotating — skip it.
    }
  }
}
