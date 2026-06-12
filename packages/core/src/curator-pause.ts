// Curator pause for the whole-vault restore (rethink T21, spec §8 / D16).
//
// While a vault restore rewrites the working tree, neither curator job may
// write through it — so the restore pauses BOTH ticks for its duration. This
// is deliberately NOT the operator's `curator.*.enabled` settings: those are
// the admin's dials and must come back exactly as they were. Instead the
// pause is its own signal, checked first thing by `runIntakeTick` and
// `runGroomingTick` (run-now included — an admin override must not race the
// restore either):
//
//   - an in-process flag — the same server process that runs the restore runs
//     the schedulers, so this is the authoritative fast path;
//   - a settings-store timestamp — visible to any OTHER process sharing the
//     data dir (e.g. a worker), and deliberately TTL-bounded: a crash between
//     pause and the try/finally resume must not leave the curator off
//     forever, so a pause record older than the TTL no longer pauses.
//
// The restore wraps pause→work→resume in try/finally; resume always runs.

import type { SettingsStore } from "./store/settings-store.js";

/** Settings key holding the ISO timestamp of the active pause (absent = not paused). */
export const CURATOR_PAUSE_KEY = "curator.paused_for_restore_at";

/**
 * Self-healing bound on a pause record (the restore itself is seconds-long;
 * a record older than this is a crashed restore's leftover, not a pause).
 */
export const CURATOR_PAUSE_TTL_MS = 15 * 60_000;

// The in-process flag — same process, no settings round-trip, no clock terms.
let pausedInProcess = false;

/** Pause both curator jobs (in-process flag + cross-process settings stamp). */
export function pauseCuratorForRestore(store: SettingsStore, now: Date = new Date()): void {
  pausedInProcess = true;
  store.setSetting(CURATOR_PAUSE_KEY, now.toISOString());
}

/** Resume the curator: clear the flag and the settings stamp. */
export function resumeCuratorAfterRestore(store: SettingsStore): void {
  pausedInProcess = false;
  store.deleteSetting(CURATOR_PAUSE_KEY);
}

/**
 * Is a vault restore in flight? Checked first by both tick entrypoints —
 * before the enable gate, so even an `allowDisabled` run-now respects it.
 */
export function isCuratorPausedForRestore(store: SettingsStore, now: Date = new Date()): boolean {
  if (pausedInProcess) return true;
  const stamp = store.getSetting(CURATOR_PAUSE_KEY);
  if (!stamp) return false;
  const pausedAt = Date.parse(stamp);
  if (Number.isNaN(pausedAt)) return false; // unreadable stamp — don't wedge the curator
  return now.getTime() - pausedAt < CURATOR_PAUSE_TTL_MS;
}
