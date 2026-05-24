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

function isState(value: unknown): value is HarnessLibrarianState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === STATE_VERSION &&
    typeof v.harness === "string" &&
    (HARNESSES as readonly string[]).includes(v.harness) &&
    typeof v.harness_session_key === "string" &&
    (v.privacy === "public" || v.privacy === "private")
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
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: FILE_MODE });
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

function acquireLock(lockPath: string, opts: StateOptions): void {
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  ensureDir(path.dirname(lockPath));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", FILE_MODE); // exclusive create
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new StateIoError(`cannot acquire lock ${lockPath}: ${(err as Error).message}`);
      }
      if (lockAge(lockPath) > staleMs) {
        fs.rmSync(lockPath, { force: true }); // reclaim an abandoned lock
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StateLockError(`lock ${lockPath} is held; gave up after ${timeoutMs}ms`);
      }
      sleepMs(Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
    }
  }
}

/** Run `fn` while holding the per-state lock; the lock is always released. */
export function withStateLock<T>(loc: StateLocation, fn: () => T, opts: StateOptions = {}): T {
  const lockPath = `${stateFilePath(loc, opts)}.lock`;
  acquireLock(lockPath, opts);
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
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
