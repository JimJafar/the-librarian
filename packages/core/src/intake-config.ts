// Intake (job 1) NON-LLM configuration, stored in the admin settings store. Holds
// the intake enablement flag, the sweep cadence, and the last-sweep timestamp — the
// knobs that gate and pace the inbox sweep. The intake LLM provider/model/timeout
// live in `curator-consumers.ts` (the shared per-consumer surface); this module is
// the intake counterpart of grooming's `grooming-config.ts`, split out so the two
// jobs' config stays cleanly separated (plan 046 R2 — `curator-config.ts` is gone).
//
// All reads use plain settings only, so they work without the master key — the admin
// cockpit can always render the configured state.
//
// NOTE: the `curator.intake.*` SETTINGS-KEY STRINGS are retained deliberately — the
// `curator.<job>.*` namespace is the umbrella name for the entity that performs both
// jobs (spec 045 Vocabulary / D-8); it is never a code symbol or a job name.

import { z } from "zod";
import type { LlmConnectionReader, LlmConnectionWriter } from "./llm-connection.js";

// Intake enablement key (spec 043 D-E). Dashboard-editable string setting
// ("true"/"false"); replaces the legacy `LIBRARIAN_CONSOLIDATOR` env opt-in, which
// now only seeds this once on first migration (see migrateJobEnablement).
export const INTAKE_ENABLED_KEY = "curator.intake.enabled";

// Intake sweep cadence (spec 045 D-3/D-8): the inbox-sweep poll interval, in whole
// minutes. The Intake scheduler reads it (env as fallback). Lives beside the intake
// enablement key under the `curator.intake.*` namespace.
export const INTAKE_INTERVAL_MINUTES_KEY = "curator.intake.interval_minutes";

// The timestamp (ISO-8601 string) of the last completed Intake inbox sweep (plan
// 046 T7). The Intake scheduler polls on a fixed short cadence and reads this to
// decide whether `curator.intake.interval_minutes` have elapsed since the last
// sweep (`isIntakeSweepDue`); it stamps this after a sweep runs. Keeping the
// cadence in a stored timestamp (rather than the scheduler's interval) is what
// makes editing the interval take effect on the next poll with no restart
// (Success Criterion #1) — the timestamp pair mirrors LAST_SCHEDULED_GROOM_KEY.
export const LAST_INTAKE_SWEEP_KEY = "curator.intake.last_sweep_at";

// Intake sweep cadence (spec 045 D-3): default = sweep the inbox every 5 minutes
// (matches the prior hard-coded LIBRARIAN_CONSOLIDATOR_TICK_MS default of 5 min).
// Positive integer minutes; an empty inbox makes each sweep a cheap no-op.
const DEFAULT_INTAKE_INTERVAL_MINUTES = 5;
const MIN_INTAKE_INTERVAL_MINUTES = 1;

// Intake's NON-LLM config surface (spec 045 D-3/D-8). Currently just the sweep
// cadence; the intake enablement flag lives in isIntakeEnabled/setIntakeEnabled and
// its provider/model/timeout in curator-consumers.ts. Kept as its own read/write
// pair (not folded into GroomingConfig, which is grooming-specific) so the two jobs'
// config stays cleanly separated, mirroring the grooming schedule write style.
export interface IntakeConfig {
  /**
   * Intake sweep cadence in whole minutes (spec 045 D-3): the inbox is swept on
   * this poll interval (positive integer; default 5). Each sweep self-gates on the
   * enable flag, then drains whatever is queued — an empty inbox is a cheap no-op.
   */
  intervalMinutes: number;
}

export interface IntakeConfigPatch {
  intervalMinutes?: number;
}

// Permissive admin-patch shape; the integer ≥ 1 bound is enforced by
// writeIntakeInterval (the single source of truth), mirroring GroomingConfigPatch.
export const IntakeConfigPatchSchema = z.strictObject({
  intervalMinutes: z.number().optional(),
});

// The slices of the store this module needs. Intake-specific keys are all plain
// (non-secret) settings; we reuse the shared reader/writer interfaces.
type ConfigReader = LlmConnectionReader;
type ConfigWriter = LlmConnectionWriter;

function parseNumber(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) ? n : fallback;
}

/**
 * Intake (job 1) enablement, read from the unified `curator.intake.enabled`
 * setting (spec 043 D-E). The setting is AUTHORITATIVE once present; the legacy
 * `LIBRARIAN_CONSOLIDATOR` env var no longer gates the job — it only seeds this
 * setting on first migration and triggers a deprecation warning while still set
 * (see migrateJobEnablement). Default off. Reads plain settings only, so it
 * works without the master key.
 */
export function isIntakeEnabled(store: ConfigReader): boolean {
  return store.getSetting(INTAKE_ENABLED_KEY) === "true";
}

/**
 * Set intake (job 1) enablement (spec 043 D-E / PR-5a). Writes the unified
 * `curator.intake.enabled` setting — the AUTHORITATIVE source `isIntakeEnabled`
 * reads — as the canonical "true"/"false" string, mirroring how grooming's enable
 * flag is written in `writeGroomingConfig`. This is the intake counterpart of that
 * grooming write: the unified curator dashboard's Intake toggle calls it.
 */
export function setIntakeEnabled(store: ConfigWriter, enabled: boolean): void {
  store.setSetting(INTAKE_ENABLED_KEY, enabled ? "true" : "false");
}

/**
 * Read intake's NON-LLM config — currently just the sweep cadence (spec 045 D-3).
 * Returns `intervalMinutes` from `curator.intake.interval_minutes`, defaulting to 5
 * when unset or corrupt (parseNumber falls back). Reads plain settings only, so it
 * works without the master key (the cockpit render path), like readGroomingConfig.
 */
export function readIntakeInterval(store: ConfigReader): IntakeConfig {
  return {
    intervalMinutes: parseNumber(
      store.getSetting(INTAKE_INTERVAL_MINUTES_KEY),
      DEFAULT_INTAKE_INTERVAL_MINUTES,
    ),
  };
}

/**
 * Patch intake's sweep cadence (spec 045 D-3/D-8). Validates `intervalMinutes` as a
 * positive integer (≥ 1) with a teaching error before touching the store, mirroring
 * writeGroomingConfig's validate-then-persist style; persists under
 * `curator.intake.interval_minutes`. The scheduler picks the new value up on its
 * next poll (wired in plan 046 T7).
 */
export function writeIntakeInterval(store: ConfigWriter, patch: IntakeConfigPatch): void {
  if (patch.intervalMinutes !== undefined) {
    const m = patch.intervalMinutes;
    if (!Number.isInteger(m) || m < MIN_INTAKE_INTERVAL_MINUTES) {
      throw new Error(`interval_minutes must be an integer >= ${MIN_INTAKE_INTERVAL_MINUTES}`);
    }
    store.setSetting(INTAKE_INTERVAL_MINUTES_KEY, String(m));
  }
}

/**
 * The last completed Intake sweep timestamp (plan 046 T7), or null if no sweep
 * has ever run. Read by the Intake scheduler to feed `isIntakeSweepDue`. A corrupt
 * (non-parseable) stored value is treated as "never swept" (null) so a bad write
 * can't wedge the sweep — it simply runs on the next poll. Mirrors
 * `readLastScheduledGroomAt`.
 */
export function readLastIntakeSweepAt(store: ConfigReader): Date | null {
  const raw = store.getSetting(LAST_INTAKE_SWEEP_KEY);
  if (raw === null) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Stamp the last completed Intake sweep timestamp (plan 046 T7). Called by the
 * Intake scheduler after a sweep runs so the next due-check advances. Mirrors
 * `writeLastScheduledGroomAt`.
 */
export function writeLastIntakeSweepAt(store: ConfigWriter, at: Date): void {
  store.setSetting(LAST_INTAKE_SWEEP_KEY, at.toISOString());
}
