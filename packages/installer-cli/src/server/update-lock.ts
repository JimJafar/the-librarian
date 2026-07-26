// The exclusive host update lock (FIX C1, moved here by spec 074 SC5).
//
// Two updates interleaving `docker stop` / `rm` / `run` on the same container
// leave a window with NO running container — the server would simply be down.
// Before 074 only the auto-update TIMER wrapper took this lock, so a manual
// `librarian server update` could still interleave with a timer fire (the lock's
// own doc claimed otherwise). The lock now lives in `runUpdate` itself — ONE
// acquisition point covering every caller — and this module exists so both
// `update.ts` (acquires) and `autoupdate.ts` (catches the typed refusal) can
// share it without a circular import.
//
// Implemented as an `O_CREAT|O_EXCL` lockfile (atomic on POSIX, no root, no
// external `flock`): the create succeeds for exactly one caller. A STALE lock
// (a crashed holder that never released) is reclaimed after {@link LOCK_STALE_MS}.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { librarianDir } from "../paths.js";

/**
 * After this many milliseconds an unrefreshed lockfile is treated as STALE and
 * reclaimed — a crashed/killed update (the holder never released its lock) must
 * not wedge updates forever. `server update` rebuilds + recreates, so a wide
 * margin (1h) is safe: a real in-flight update is far shorter, and a lock older
 * than this is from a dead process, not a slow one.
 */
const LOCK_STALE_MS = 60 * 60 * 1000;

/** The fixed lock path: `<deployDir>/.autoupdate.lock` (no root needed). */
export function updateLockPath(options: {
  home?: string | undefined;
  dir?: string | undefined;
}): string {
  const dir = options.dir ?? path.join(librarianDir(options.home), "server");
  return path.join(dir, ".autoupdate.lock");
}

/**
 * The typed refusal `runUpdate` throws when another update holds the lock. The
 * manual CLI surfaces `.message` as a teaching line; the auto-update wrapper
 * catches the TYPE and logs its skip line instead (without stamping — the
 * in-flight holder stamps).
 */
export class UpdateInProgressError extends Error {
  constructor(lockPath: string) {
    super(
      `Another update is already in progress (lock: ${lockPath}).\n` +
        "A concurrent `librarian server update` or auto-update timer fire holds the exclusive " +
        "update lock — wait for it to finish and re-run. If a previous update CRASHED, the " +
        "lock is reclaimed automatically after 1 hour; remove the file yourself only if " +
        "you're certain nothing is updating right now.",
    );
    this.name = "UpdateInProgressError";
  }
}

/** A held lock — call `release()` exactly once when the critical section ends. */
export interface HeldLock {
  release(): void;
}

/**
 * Acquire the EXCLUSIVE host update lock. Returns the held lock on success, or
 * `null` when another update already holds it. A STALE lock (older than
 * {@link LOCK_STALE_MS} — a crashed holder) is reclaimed once, then retried.
 *
 * Any lock-subsystem error (a read-only FS, a permissions problem) THROWS — the
 * manual path surfaces it as an ordinary failure; the auto-update wrapper's
 * outer fail-soft guard logs + skips (a lock problem must never crash the timer
 * or leave the server mid-recreate).
 */
export function acquireUpdateLock(lockPath: string): HeldLock | null {
  // Best-effort: ensure the directory exists (the deploy dir normally does).
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const tryCreate = (): HeldLock | null => {
    let fd: number;
    try {
      // O_CREAT|O_EXCL|O_WRONLY → fails with EEXIST if the lockfile already exists.
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error; // a real FS error → the caller decides (fail vs fail-soft)
    }
    // Record our pid + acquisition time (debuggable; carries NO secret).
    try {
      writeSync(fd, `${process.pid} ${Date.now()}\n`);
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone (e.g. reclaimed as stale elsewhere) — nothing to do.
        }
      },
    };
  };

  const held = tryCreate();
  if (held) return held;

  // The lock exists. If it's STALE (a crashed holder), reclaim it ONCE and retry.
  if (isLockStale(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Someone else reclaimed it first — fall through to a single retry anyway.
    }
    return tryCreate(); // null again ⇒ a live holder won the race → skip
  }
  return null; // a live update is in progress → skip
}

/** True iff the lockfile is older than {@link LOCK_STALE_MS} (a crashed holder). */
function isLockStale(lockPath: string): boolean {
  try {
    // Prefer the timestamp written into the file; fall back to mtime.
    const written = Number.parseInt(
      readFileSync(lockPath, "utf8").trim().split(/\s+/)[1] ?? "",
      10,
    );
    const acquiredAt = Number.isFinite(written) ? written : statSync(lockPath).mtimeMs;
    return Date.now() - acquiredAt >= LOCK_STALE_MS;
  } catch {
    return false; // can't read it → don't reclaim (conservative: skip, don't steal)
  }
}
