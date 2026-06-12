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
//
// The standing primer also carries the operator's WORKING-STYLE preamble. That
// preamble used to ride the now-retired `session_manifest` tool (ADR 0006); with
// that gone, working-style is folded into the primer text `conv_state_get`
// injects every turn, so editable per-session guidance reaches the model through
// the channel it already uses. Its read is independently fail-soft — a throw on
// the working-style key degrades to "just the awareness note", never blocks the
// turn.

import type { SettingsStore } from "./store/settings-types.js";

/** The flat settings key holding the operator-authored awareness primer. */
export const AWARENESS_PRIMER_KEY = "awareness.primer";

/**
 * The flat settings key holding the operator-authored WORKING-STYLE preamble
 * (prose authored via the dashboard). Appended to the standing primer when set.
 */
export const WORKING_STYLE_KEY = "working_style";

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
function readAwarenessNote(store: Pick<SettingsStore, "getSetting">): string {
  try {
    const value = store.getSetting(AWARENESS_PRIMER_KEY);
    return value === null ? DEFAULT_AWARENESS_PRIMER : value;
  } catch {
    return "";
  }
}

/**
 * Read the working-style preamble fail-soft. Mirrors the posture of the retired
 * `session_manifest`'s `readWorkingStyle` — a settings read (e.g. a secret-stored
 * value with no master key) must never throw out of the per-turn primer assembly.
 */
function readWorkingStyle(store: Pick<SettingsStore, "getSetting">): string {
  try {
    return store.getSetting(WORKING_STYLE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Read the standing primer that `conv_state_get` injects every turn: the
 * awareness note plus, when set, the operator's working-style preamble. Both
 * reads are fail-soft — a locked/unreadable store degrades to whatever did read,
 * never throws, never blocks the turn.
 *
 *   - awareness note "" (disabled) + no working-style → "" (no block);
 *   - awareness note set + working-style set → the two joined (note first);
 *   - working-style set while the note is disabled → just the working-style text.
 */
export function readAwarenessPrimer(store: Pick<SettingsStore, "getSetting">): string {
  const note = readAwarenessNote(store);
  const workingStyle = readWorkingStyle(store).trim();
  if (!workingStyle) return note;
  return note ? `${note}\n\n${workingStyle}` : workingStyle;
}
