// Server auto-update NON-LLM configuration, stored in the admin settings store.
// Holds the auto-update enablement flag, the cadence (daily/weekly), and the
// last-run timestamp — the knobs that gate and pace the host-scheduled
// auto-update wrapper (`librarian server autoupdate --run`).
//
// The host scheduler (a systemd timer, cron fallback) fires frequently and runs
// the wrapper; the wrapper reads these settings + a due-check, then conditionally
// calls `server update` (spec 2026-06-16-server-autoupdate §2/§4). Keeping the
// cadence as a stored due-check (rather than the timer period) is what lets the
// dashboard change cadence with NO host action — the wrapper just changes when it
// considers itself due (mirrors the intake sweep: fixed poll + last-run timestamp).
//
// All reads use plain settings only, so they work without the master key — the
// admin dashboard can always render the configured state (mirrors intake-config.ts).

import type { LlmConnectionReader, LlmConnectionWriter } from "./llm-connection.js";

// Auto-update enablement key. Dashboard-editable string setting ("true"/"false").
// The host wrapper updates IFF this is true AND the cadence has elapsed (§3 SC4).
export const SERVER_AUTOUPDATE_ENABLED_KEY = "server.autoupdate.enabled";

// Auto-update cadence: `"daily"` (default) or `"weekly"`. The due-check
// (`isAutoUpdateDue`) reads it to decide whether enough time has elapsed since
// the last run. Editing it takes effect on the next timer fire with no host action.
export const SERVER_AUTOUPDATE_CADENCE_KEY = "server.autoupdate.cadence";

// The timestamp (ISO-8601 string) of the last completed auto-update run. The host
// wrapper stamps this only after a SUCCESSFUL `server update`; a failed update
// leaves it unstamped so the next due-check still fires (so it retries) — §3 SC7.
export const SERVER_AUTOUPDATE_LAST_RUN_KEY = "server.autoupdate.last_run_at";

/** The two valid cadences (a const tuple so the type + the runtime guard agree). */
export const AUTOUPDATE_CADENCES = ["daily", "weekly"] as const;

/** The auto-update cadence — how often the wrapper considers itself due. */
export type AutoUpdateCadence = (typeof AUTOUPDATE_CADENCES)[number];

/** Default cadence when the setting is unset or corrupt: daily. */
export const DEFAULT_AUTOUPDATE_CADENCE: AutoUpdateCadence = "daily";

/** Whole-day span each cadence maps to in the due-check (daily = 1, weekly = 7). */
const CADENCE_DAYS: Record<AutoUpdateCadence, number> = {
  daily: 1,
  weekly: 7,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The slices of the store this module needs. All keys are plain (non-secret)
// settings; reuse the shared reader/writer interfaces (as intake-config does).
type ConfigReader = LlmConnectionReader;
type ConfigWriter = LlmConnectionWriter;

/** True iff `value` is one of the two valid cadences. */
export function isAutoUpdateCadence(value: string): value is AutoUpdateCadence {
  return (AUTOUPDATE_CADENCES as readonly string[]).includes(value);
}

/**
 * Auto-update enablement, read from the `server.autoupdate.enabled` setting.
 * Default off — a host never auto-updates until an operator opts in (via the CLI
 * `autoupdate enable` or the dashboard toggle). Reads plain settings only, so it
 * works without the master key (the dashboard render + the host wrapper read).
 */
export function isAutoUpdateEnabled(store: ConfigReader): boolean {
  return store.getSetting(SERVER_AUTOUPDATE_ENABLED_KEY) === "true";
}

/**
 * Set auto-update enablement. Writes `server.autoupdate.enabled` as the canonical
 * "true"/"false" string (mirrors `setIntakeEnabled`). The CLI `autoupdate
 * enable`/`disable` and the dashboard toggle call it. Disabling leaves the timer
 * installed (the next `--run` no-ops) — uninstalling the timer is a separate step.
 */
export function setAutoUpdateEnabled(store: ConfigWriter, enabled: boolean): void {
  store.setSetting(SERVER_AUTOUPDATE_ENABLED_KEY, enabled ? "true" : "false");
}

/**
 * Read the auto-update cadence from `server.autoupdate.cadence`, defaulting to
 * `daily` when unset or holding an unrecognised value (so a corrupt setting can
 * never wedge the wrapper into a bogus interval). Reads plain settings only.
 */
export function readAutoUpdateCadence(store: ConfigReader): AutoUpdateCadence {
  const raw = store.getSetting(SERVER_AUTOUPDATE_CADENCE_KEY);
  return raw !== null && isAutoUpdateCadence(raw) ? raw : DEFAULT_AUTOUPDATE_CADENCE;
}

/**
 * Set the auto-update cadence (`daily` | `weekly`). Validates the value with a
 * teaching error before touching the store (the single source of truth, mirroring
 * `writeIntakeInterval`); persists under `server.autoupdate.cadence`. The wrapper
 * picks the new cadence up on its next due-check — no host action, no restart.
 */
export function setAutoUpdateCadence(store: ConfigWriter, cadence: string): void {
  if (!isAutoUpdateCadence(cadence)) {
    throw new Error(`cadence must be one of ${AUTOUPDATE_CADENCES.join(" | ")}, got '${cadence}'`);
  }
  store.setSetting(SERVER_AUTOUPDATE_CADENCE_KEY, cadence);
}

/**
 * The last completed auto-update timestamp, or null if no auto-update has ever
 * run. Read by the host wrapper to feed `isAutoUpdateDue`. A corrupt
 * (non-parseable) stored value is treated as "never run" (null) so a bad write
 * can't wedge auto-update — it simply runs on the next due timer fire. Mirrors
 * `readLastIntakeSweepAt`.
 */
export function readLastAutoUpdateAt(store: ConfigReader): Date | null {
  const raw = store.getSetting(SERVER_AUTOUPDATE_LAST_RUN_KEY);
  if (raw === null) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Stamp the last completed auto-update timestamp. The host wrapper calls it ONLY
 * after a successful `server update` so the next due-check advances; a failed
 * update leaves it unstamped (so the wrapper retries on the next fire). Mirrors
 * `writeLastIntakeSweepAt`.
 */
export function writeLastAutoUpdateAt(store: ConfigWriter, at: Date): void {
  store.setSetting(SERVER_AUTOUPDATE_LAST_RUN_KEY, at.toISOString());
}

/**
 * Is an auto-update due now? The gate the host wrapper applies (spec §3 SC4 /
 * §4): auto-update runs IFF it is ENABLED **and** the cadence has elapsed since
 * the last run. An elapsed-days gate (NOT a wall-clock schedule), mirroring the
 * intake sweep's `isIntakeSweepDue` so editing the cadence takes effect on the
 * next timer fire with no restart.
 *
 * - **Disabled**: never due (the wrapper no-ops + logs a one-line skip).
 * - **Enabled + never run** (`last_run_at` unset/corrupt → null): due now, so a
 *   freshly-enabled host updates on the first timer fire rather than waiting a
 *   full cadence.
 * - **Enabled + run before**: due once `now - last_run_at >= cadenceDays`.
 *
 * The frequent timer (≈hourly) is the resolution floor; this gate is what keeps
 * the wrapper from updating more than once per cadence window.
 */
export function isAutoUpdateDue(store: ConfigReader, now: Date): boolean {
  if (!isAutoUpdateEnabled(store)) return false;
  const lastRunAt = readLastAutoUpdateAt(store);
  if (lastRunAt === null) return true;
  const cadenceDays = CADENCE_DAYS[readAutoUpdateCadence(store)];
  return now.getTime() - lastRunAt.getTime() >= cadenceDays * MS_PER_DAY;
}
