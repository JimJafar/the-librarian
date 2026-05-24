// Local harness state (spec §4, §9).
//
// Every harness integration needs durable local state — we cannot rely on
// LIBRARIAN_SESSION_ID alone because hooks generally cannot export env vars
// back into an already-running parent process (§4). This module owns that
// state: where it lives, how it is read/written, and the locking that lets
// concurrent hooks mutate it safely.
//
// Two non-negotiables from the spec drive the design:
//   - the state may identify sessions but must never hold private prompt
//     text or summaries (§4.1); callers are responsible for that.
//   - if state cannot be read or written, the integration must FAIL CLOSED
//     (do not call The Librarian automatically, §4.2/§9). We surface that
//     by throwing StateIoError rather than returning a usable value — a
//     corrupt or unreadable file is never silently treated as "no state".

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HARNESSES = ["claude-code", "codex", "hermes", "opencode", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

export const STATE_VERSION = 1 as const;

export interface HarnessLibrarianState {
  version: typeof STATE_VERSION;
  harness: Harness;
  harness_session_key: string;
  source_ref?: string;
  cwd?: string;
  project_key?: string;
  librarian_session_id?: string;
  privacy: "public" | "private";
  entered_private_at?: string;
  last_activity_at?: string;
  last_checkpoint_at?: string;
}

/** The non-secret identifiers that locate a state file (§4.2). */
export interface StateLocation {
  harness: Harness;
  harnessSessionKey: string;
  sourceRef?: string;
  cwd?: string;
  projectKey?: string;
}

export interface StateOptions {
  /** Override the state root; defaults to ~/.librarian/harness-state. */
  baseDir?: string;
  /** Max time to wait for the lock before throwing StateLockError. */
  lockTimeoutMs?: number;
  /** A lock older than this is considered abandoned and reclaimed. */
  lockStaleMs?: number;
}

/** Read/write/parse failure — the signal to fail closed (§4.2/§9). */
export class StateIoError extends Error {
  override readonly name = "StateIoError";
}

/** Could not acquire the per-state lock within the timeout (§9). */
export class StateLockError extends Error {
  override readonly name = "StateLockError";
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;

export function defaultStateBaseDir(): string {
  return path.join(os.homedir(), ".librarian", "harness-state");
}

function baseDirOf(opts: StateOptions): string {
  return opts.baseDir ?? defaultStateBaseDir();
}

// Hash the non-secret location identifiers into a stable filename. Order is
// fixed and fields are NUL-joined so distinct locations cannot collide by
// concatenation (e.g. "ab"+"c" vs "a"+"bc").
function locationHash(loc: StateLocation): string {
  const parts = [loc.harnessSessionKey, loc.cwd ?? "", loc.sourceRef ?? "", loc.projectKey ?? ""];
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40);
}

export function stateFilePath(loc: StateLocation, opts: StateOptions = {}): string {
  return path.join(baseDirOf(opts), loc.harness, `${locationHash(loc)}.json`);
}

function locationOf(state: HarnessLibrarianState): StateLocation {
  const loc: StateLocation = {
    harness: state.harness,
    harnessSessionKey: state.harness_session_key,
  };
  if (state.source_ref !== undefined) loc.sourceRef = state.source_ref;
  if (state.cwd !== undefined) loc.cwd = state.cwd;
  if (state.project_key !== undefined) loc.projectKey = state.project_key;
  return loc;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is umask-masked; chmod the leaf to guarantee 0700 (§4.2).
  fs.chmodSync(dir, DIR_MODE);
}

function optionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function isState(value: unknown): value is HarnessLibrarianState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === STATE_VERSION &&
    typeof v.harness === "string" &&
    (HARNESSES as readonly string[]).includes(v.harness) &&
    typeof v.harness_session_key === "string" &&
    (v.privacy === "public" || v.privacy === "private") &&
    // Optional fields, when present, must be strings — a malformed one
    // fails closed rather than loading partially-typed state.
    optionalString(v.source_ref) &&
    optionalString(v.cwd) &&
    optionalString(v.project_key) &&
    optionalString(v.librarian_session_id) &&
    optionalString(v.entered_private_at) &&
    optionalString(v.last_activity_at) &&
    optionalString(v.last_checkpoint_at)
  );
}

/** Load state, or null if none exists. Throws StateIoError if present but unreadable/invalid. */
export function loadState(
  loc: StateLocation,
  opts: StateOptions = {},
): HarnessLibrarianState | null {
  const file = stateFilePath(loc, opts);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StateIoError(`cannot read harness state at ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateIoError(`harness state at ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isState(parsed)) {
    throw new StateIoError(`harness state at ${file} is structurally invalid`);
  }
  return parsed;
}

/** Persist state atomically with 0700/0600 permissions. Throws StateIoError on failure. */
export function saveState(state: HarnessLibrarianState, opts: StateOptions = {}): void {
  const file = stateFilePath(locationOf(state), opts);
  const dir = path.dirname(file);
  // A unique temp name in the same directory keeps the final rename atomic
  // (same filesystem) and collision-free under concurrent writers (§9).
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    ensureDir(dir);
    // Exclusive create (wx) refuses to follow a pre-planted symlink at the
    // temp path and makes the name-collision impossible rather than merely
    // improbable. chmod after still guards against umask masking the mode.
    const fd = fs.openSync(tmp, "wx", FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    throw new StateIoError(`cannot write harness state at ${file}: ${(err as Error).message}`);
  }
}

function sleepMs(ms: number): void {
  if (ms <= 0) return;
  // Synchronous sleep without a busy loop — hooks run in short-lived sync
  // processes, so blocking here is correct and cheaper than spinning.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockAge(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // vanished → treat as reclaimable
  }
}

// Reclaim an abandoned lock without an unconditional delete. Racing
// reclaimers must NOT both `rm` the path — that lets a loser stomp the
// fresh lock a winner just created. Instead we atomically rename the
// stale file out of the way: exactly one process's rename succeeds; the
// others get ENOENT and simply loop back to let O_EXCL arbitrate. The
// exclusive create remains the single serialization point.
function reclaimStaleLock(lockPath: string): void {
  const claim = `${lockPath}.reclaim.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, claim);
    fs.rmSync(claim, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // another reclaimer won
    throw new StateIoError(`cannot reclaim stale lock ${lockPath}: ${(err as Error).message}`);
  }
}

function acquireLock(lockPath: string, opts: StateOptions): string {
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  // A unique token identifies *our* hold, so release only removes our own
  // lock and never one a later holder placed after reclaiming ours.
  const token = `${process.pid}:${crypto.randomUUID()}`;
  ensureDir(path.dirname(lockPath));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", FILE_MODE); // exclusive create
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new StateIoError(`cannot acquire lock ${lockPath}: ${(err as Error).message}`);
      }
      if (lockAge(lockPath) > staleMs) {
        reclaimStaleLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StateLockError(`lock ${lockPath} is held; gave up after ${timeoutMs}ms`);
      }
      sleepMs(Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
    }
  }
}

// Release only if the lock still carries our token. If it was reclaimed
// (we outran staleMs) and another holder now owns it, leave it alone.
function releaseLock(lockPath: string, token: string): void {
  let current: string;
  try {
    current = fs.readFileSync(lockPath, "utf8");
  } catch {
    return; // already gone or unreadable — nothing safe to do
  }
  if (current === token) {
    fs.rmSync(lockPath, { force: true });
  }
}

/** Run `fn` while holding the per-state lock; the lock is always released. */
export function withStateLock<T>(loc: StateLocation, fn: () => T, opts: StateOptions = {}): T {
  const lockPath = `${stateFilePath(loc, opts)}.lock`;
  const token = acquireLock(lockPath, opts);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

/** Lock + load + mutate + save, the read-modify-write path hooks should use. */
export function updateState(
  loc: StateLocation,
  mutate: (current: HarnessLibrarianState | null) => HarnessLibrarianState,
  opts: StateOptions = {},
): HarnessLibrarianState {
  return withStateLock(
    loc,
    () => {
      const next = mutate(loadState(loc, opts));
      saveState(next, opts);
      return next;
    },
    opts,
  );
}
