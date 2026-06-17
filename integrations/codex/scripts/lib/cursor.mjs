// Codex auto-capture adapter — the per-conversation byte-offset cursor (testable).
// Spec 2026-06-16-harness-auto-capture, Phase 2A. Mirrors the Claude cursor
// (integrations/claude/scripts/lib/cursor.mjs), keyed by the Codex conv_id
// (deriveConvId — a stable session id, else the transcript filename; NEVER
// $USER/cwd) instead of Claude's session_id.
//
// The cursor is the adapter's only durable state. Per conversation it records:
//   - `offset`  : how many bytes of the transcript we have already shipped (or
//                 skipped-as-private). The next run reads from here to EOF.
//   - `seq`     : the adapter's monotonic delta counter for the contract payload.
//   - `private` : whether the previous run ended inside an open `[private=on]`
//                 span (carry-forward) — an unterminated span stays private.
//
// Home: `${CODEX_PLUGIN_DATA:-$HOME/.librarian/codex-plugin-data}/cursors/
// <conv_id>`. NON-CRITICAL: if lost, the hook re-ships from 0 and idempotency
// rests on advance-on-ack + the curator's fact-level dedup. Every read is
// fail-soft (a missing/corrupt cursor reads as a fresh start).
//
// Concurrency: keyed by conv_id ONLY (never $USER/cwd), so N concurrent
// same-machine Codex runs get N distinct cursor files. Pruning is AGE-BASED —
// never "clear all" (that would clobber a live sibling run).

import fs from "node:fs";
import path from "node:path";

/** Resolve the cursors directory under the plugin data dir. */
export function cursorsDir(dataDir) {
  return path.join(dataDir, "cursors");
}

/**
 * Reduce a conv_id to a single safe path segment so a hostile/odd id can't
 * traverse out of `cursors/`. Mirrors the server's `sanitizeConvId`.
 */
function safeSegment(convId) {
  const cleaned = String(convId ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.\.+/g, "_") // collapse any `..` run — never a parent-dir reference
    .replace(/^\.+/, "_") // never a leading dot (no `.` / dotfiles)
    .slice(0, 200);
  return cleaned || "unknown";
}

/** Absolute path of a conversation's cursor file. */
export function cursorPath(dataDir, convId) {
  return path.join(cursorsDir(dataDir), safeSegment(convId));
}

/**
 * Read a conversation's cursor. Fail-soft: a missing or unparseable cursor reads
 * as a fresh start (`offset:0, seq:0, private:false`) — re-shipping is safe.
 *
 * @returns {{offset:number, seq:number, private:boolean}}
 */
export function readCursor(dataDir, convId) {
  const fresh = { offset: 0, seq: 0, private: false };
  try {
    const raw = fs.readFileSync(cursorPath(dataDir, convId), "utf8");
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
 * Persist a conversation's cursor. Written atomically (tmp + rename) so a crash
 * mid-write can never leave a torn cursor a concurrent run misreads. Fail-soft: a
 * write failure is swallowed (losing the cursor only costs an idempotent re-ship).
 *
 * @param {{offset:number, seq:number, private:boolean}} state
 */
export function writeCursor(dataDir, convId, state) {
  try {
    const dir = cursorsDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const target = cursorPath(dataDir, convId);
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
 * Age-based pruning: drop cursor files whose mtime is older than `maxAgeMs`. NEVER
 * "clear all" — a fresh sibling cursor (a concurrently-running run) must survive.
 * Fail-soft: a missing dir or an un-stat-able file is skipped, never thrown.
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
      // Race with a concurrent run writing/rotating — skip it.
    }
  }
}
