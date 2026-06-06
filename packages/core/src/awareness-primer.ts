// Awareness primer (spec 041, feature 1B) — a short, server-sourced note injected
// on every harness turn telling the model that The Librarian exists and which
// verbs to reach for. It rides the existing per-turn conv-state injection channel
// (A2 wires it into `conv_state_get`; the five plugins render it).
//
// Storage: a single flat settings key (`awareness.primer`). Semantics:
//   - key NULL (never set) → reads back the SHIPPED DEFAULT (the primer works
//     out-of-the-box, before any admin edit);
//   - key "" (explicitly empty) → DISABLES the primer (reads back "", no block);
//   - any other string → the operator's custom primer (round-trips verbatim).
//
// Reads are FAIL-SOFT: this fires every turn, so a locked/unreadable settings
// store (e.g. a secret-stored value with no master key) must never throw — it
// degrades to "" (no primer), same posture as `readWorkingStyle`.

import type { SettingsStore } from "./store/settings-types.js";

/** The flat settings key holding the operator-authored awareness primer. */
export const AWARENESS_PRIMER_KEY = "awareness.primer";

/**
 * The shipped default primer (spec 041 Decision 3 — verbatim). Pre-filled in the
 * dashboard and returned whenever the setting has never been written; phrased to
 * read sensibly even mid-off-record ("worth keeping", not "always remember").
 */
export const DEFAULT_AWARENESS_PRIMER =
  "You have The Librarian: durable, cross-session memory. " +
  "Use `recall` to check what's already known before asking; " +
  "use `remember` / `/learn` to save durable facts, preferences, and decisions worth keeping.";

/**
 * Read the awareness primer fail-soft.
 *
 *   - the key is null (never set)  → the shipped default (pre-filled out-of-box);
 *   - the key is "" (disabled)     → "" (no primer block anywhere);
 *   - the key is any other string  → that string verbatim;
 *   - the store throws (locked/unreadable) → "" (NEVER throws — this read fires
 *     every turn once A2 wires it into `conv_state_get`, and must not block it).
 */
export function readAwarenessPrimer(store: Pick<SettingsStore, "getSetting">): string {
  try {
    const value = store.getSetting(AWARENESS_PRIMER_KEY);
    return value === null ? DEFAULT_AWARENESS_PRIMER : value;
  } catch {
    return "";
  }
}
