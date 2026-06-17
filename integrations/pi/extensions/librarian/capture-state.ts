// Per-session auto-capture state — the adapter's only durable capture state.
// Phase 2B / T-Pi. Records, PER SESSION (keyed by Pi's getSessionId()):
//   - `seq`     : the adapter's monotonic delta counter for the /transcript
//                 contract payload.
//   - `private` : whether the previous delta ended inside an open `[private=on]`
//                 span (carry-forward, so an unterminated span stays private into
//                 the next delta — even across a process restart within a session).
//
// There is NO byte offset (unlike the Claude cursor): the `agent_end` hook hands
// the adapter the completed turn IN-PAYLOAD, so there is nothing to re-read. The
// state is NON-CRITICAL: if lost, the next delta restarts at seq 0 / public and
// idempotency rests on the server/curator's fact-level dedup + advance-on-ack. So
// every read is fail-soft (a missing/corrupt file reads as a fresh start).
//
// Concurrency (spec §4.11 / SC5): keyed by the SESSION ID ONLY (never `$USER`/
// cwd), so N concurrent same-machine sessions get N distinct files. Pruning is
// AGE-BASED — never "clear all" (that would clobber a live sibling session).
//
// RUNTIME-IMPORT NOTE: only `node:` builtins + relative paths here, so the module
// loads in a git/local Pi install with no node_modules (tests/runtime-imports).

import fs from "node:fs";
import path from "node:path";

/** A session's durable capture state. */
export interface CaptureState {
  seq: number;
  private: boolean;
}

/** The capture-state directory under the plugin data dir. */
export function captureDir(dataDir: string): string {
  return path.join(dataDir, "capture");
}

/**
 * Reduce a session id to a single safe path segment so a hostile/odd id can't
 * traverse out of `capture/`. Mirrors the server's `sanitizeConvId`, the Claude
 * cursor's `safeSegment`, and the Hermes `_safe_segment`.
 */
function safeSegment(sessionId: string): string {
  const cleaned = String(sessionId ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.\.+/g, "_") // collapse any `..` run — never a parent-dir reference
    .replace(/^\.+/, "_") // never a leading dot (no `.` / dotfiles)
    .slice(0, 200);
  return cleaned || "unknown";
}

/** Absolute path of a session's capture-state file. */
export function captureStatePath(dataDir: string, sessionId: string): string {
  return path.join(captureDir(dataDir), `${safeSegment(sessionId)}.json`);
}

/**
 * Read a session's capture state. Fail-soft: a missing or unparseable file reads
 * as a fresh start (`{seq:0, private:false}`) — re-shipping is safe (the
 * server/curator dedup), so this never throws.
 */
export function readCaptureState(dataDir: string, sessionId: string): CaptureState {
  const fresh: CaptureState = { seq: 0, private: false };
  try {
    const raw = fs.readFileSync(captureStatePath(dataDir, sessionId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fresh;
    const obj = parsed as { seq?: unknown; private?: unknown };
    return {
      seq: Number.isInteger(obj.seq) && (obj.seq as number) >= 0 ? (obj.seq as number) : 0,
      private: obj.private === true,
    };
  } catch {
    return fresh;
  }
}

/**
 * Persist a session's capture state. Written atomically (tmp + rename) so a crash
 * mid-write can never leave a torn file a concurrent run misreads. Fail-soft: a
 * write failure is swallowed (the caller already shipped; a lost state file only
 * costs an idempotent re-ship next delta).
 */
export function writeCaptureState(dataDir: string, sessionId: string, state: CaptureState): void {
  try {
    const dir = captureDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const target = captureStatePath(dataDir, sessionId);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ seq: state.seq, private: Boolean(state.private) }),
      "utf8",
    );
    fs.renameSync(tmp, target);
  } catch {
    // Non-critical state; a lost file self-heals via re-ship + dedup.
  }
}

/**
 * Age-based pruning (SC5-adjacent housekeeping): drop state files whose mtime is
 * older than `maxAgeMs`. NEVER "clear all" — a fresh sibling file (a concurrently
 * running session) must survive. Fail-soft: a missing dir or an un-stat-able file
 * is skipped, never thrown.
 */
export function pruneOldState(dataDir: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const dir = captureDir(dataDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no capture dir yet — nothing to prune
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
