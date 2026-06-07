// Curator configuration (memory-curator spec §7.1), stored in the admin
// settings store. Operator-managed: enable flag, auto-apply posture, and
// schedule. The LLM connection no longer lives here — providers are named +
// dashboard-managed (`llm-providers.ts`) and each consumer (intake / grooming)
// picks its own provider+model (`curator-consumers.ts`). The prompt addendum
// likewise left this config in spec 044 D-1 — both jobs' addenda are now
// git-committed vault files (`curator-addendum.ts`), versioned by commit hash.
// This config carries only the curator's NON-LLM, NON-addendum knobs.
//
// `readCuratorConfig` reads plain settings only, so it works without the master
// key — the admin cockpit can always render the configured state.

import { z } from "zod";
import type { LlmConnectionReader, LlmConnectionWriter } from "./llm-connection.js";

// Curator-specific keys (enable flag, auto-apply, schedule). Grooming's
// enablement now lives under the unified `curator.grooming.enabled` key (spec
// 043 D-E); the legacy `curator.enabled` is read once at migration time and
// never again (see migrateCuratorEnablement / LEGACY_GROOMING_ENABLED_KEY).
const KEYS = {
  enabled: "curator.grooming.enabled",
  // Auto-apply policy (spec 045 D-8): moved under the grooming job namespace from
  // the un-prefixed umbrella keys. Read here; the legacy keys are seeded once into
  // these by migrateCuratorGroomingSchedule and then never read again.
  defaultAutoApply: "curator.grooming.default_auto_apply",
  autoApplyConfidence: "curator.grooming.auto_apply_confidence",
  // Grooming wall-clock schedule (spec 045 D-3): run every N days at HH:MM
  // (server-local time). Default = every 1 day at 03:00 (nightly at 3 AM).
  intervalDays: "curator.grooming.interval_days",
  scheduleTime: "curator.grooming.schedule_time",
  // Post-intake threshold trigger (spec 043 D-A/D-D). Grooming no longer runs on a
  // wall-clock cron — it's triggered after an intake sweep crosses a threshold:
  triggerThreshold: "curator.grooming.trigger_threshold",
  // The repurposed interval (D-A): a debounce FLOOR, not a cadence — never
  // auto-trigger a groom within this many minutes of the last one. Seeded from the
  // legacy curator.interval_minutes at migration (see migrateCuratorEnablement).
  debounceMinutes: "curator.grooming.debounce_minutes",
  // Bounded grooming runs (ADR 0005): the MAX active+proposed memories a single
  // grooming run feeds the model. A slice larger than this is truncated (newest-
  // first) so one oversized slice can't blow past the LLM timeout. Default 200
  // (the prior implicit cap) — lower it for slow models / large slices.
  maxMemoriesPerRun: "curator.grooming.max_memories",
} as const;

// Unified curator enablement keys (spec 043 D-E). BOTH jobs' on/off flags now
// live under the `curator.*` namespace as dashboard-editable string settings
// ("true"/"false"), replacing the two legacy sources:
//   grooming: curator.enabled            (a setting)  → curator.grooming.enabled
//   intake:   LIBRARIAN_CONSOLIDATOR env (an env var) → curator.intake.enabled
export const GROOMING_ENABLED_KEY = "curator.grooming.enabled";
export const INTAKE_ENABLED_KEY = "curator.intake.enabled";

// Intake sweep cadence (spec 045 D-3/D-8): the inbox-sweep poll interval, in whole
// minutes. New in plan 046 T2; the Intake scheduler reads it (env as fallback) in
// T7. Lives beside the intake enablement key under the `curator.intake.*` namespace.
export const INTAKE_INTERVAL_MINUTES_KEY = "curator.intake.interval_minutes";

// The pre-043 grooming enablement setting. Read ONLY by migrateCuratorEnablement
// to seed the new key once; the scheduler never reads it again.
export const LEGACY_GROOMING_ENABLED_KEY = "curator.enabled";

// Pre-045 un-prefixed / pre-043 schedule keys, read ONLY at migration time to
// seed the new curator.grooming.* keys once (see migrateCuratorGroomingSchedule).
// `curator.interval_minutes` keeps its existing debounce-seed role in
// migrateCuratorEnablement, but is no longer read for the grooming cadence.
const LEGACY_DEFAULT_AUTO_APPLY_KEY = "curator.default_auto_apply";
const LEGACY_AUTO_APPLY_CONFIDENCE_KEY = "curator.auto_apply_confidence";
const LEGACY_SCHEDULE_TIME_KEY = "curator.schedule.time";
const LEGACY_SCHEDULE_INTERVAL_DAYS_KEY = "curator.schedule.interval_days";
const LEGACY_INTERVAL_MINUTES_KEY = "curator.interval_minutes";

// Legacy keys retained only so a present value can be detected and logged at
// boot (§12.4 disable-by-default cadence). They are no longer read by the
// scheduler — operators get a notice instead of silent behaviour change.
export const LEGACY_SCHEDULE_KEYS = [
  "curator.schedule.interval_days",
  "curator.schedule.time",
  "curator.schedule.min_sessions_since_run",
] as const;

export type AutoApplyLevel = "off" | "safe_only" | "high_confidence";
const AUTO_APPLY_LEVELS: readonly AutoApplyLevel[] = ["off", "safe_only", "high_confidence"];

// Spec defaults (§7.2 / §12.4).
const DEFAULT_AUTO_APPLY: AutoApplyLevel = "safe_only";
const DEFAULT_CONFIDENCE = 0.9;
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60; // one week

// Grooming wall-clock schedule (spec 045 D-3). Default = every 1 day at 03:00 =
// nightly at 3 AM; weekly = 7, ~monthly = 30 (days-only, no calendar-month math).
const DEFAULT_INTERVAL_DAYS = 1;
const MIN_INTERVAL_DAYS = 1;
const DEFAULT_SCHEDULE_TIME = "03:00";

// Intake sweep cadence (spec 045 D-3): default = sweep the inbox every 5 minutes
// (matches the prior hard-coded LIBRARIAN_CONSOLIDATOR_TICK_MS default of 5 min).
// Positive integer minutes; an empty inbox makes each sweep a cheap no-op.
const DEFAULT_INTAKE_INTERVAL_MINUTES = 5;
const MIN_INTAKE_INTERVAL_MINUTES = 1;
// 24-hour HH:MM, 00:00–23:59. Leading zero required (rejects "3:00"); rejects
// "24:00" and ":60" minutes.
const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// Post-intake threshold trigger defaults (spec 043 D-A/D-D).
//
// trigger_threshold = the number of memories created/augmented/superseded by intake
// since the last groom that arms one grooming run. Default 20: a meaningful burst of
// new knowledge (a session's worth of ingestion) without grooming after every trickle.
// debounce_minutes = the repurposed interval default (60) — at most one auto-groom per
// hour regardless of how many sweeps cross the threshold.
const DEFAULT_TRIGGER_THRESHOLD = 20;
const MIN_TRIGGER_THRESHOLD = 1;
const DEFAULT_DEBOUNCE_MINUTES = DEFAULT_INTERVAL_MINUTES;
const MIN_DEBOUNCE_MINUTES = MIN_INTERVAL_MINUTES;
const MAX_DEBOUNCE_MINUTES = MAX_INTERVAL_MINUTES;

// Bounded grooming runs (ADR 0005). The default matches the prior implicit cap
// (curator-worker's DEFAULT_MAX_MEMORIES) so existing installs are unchanged; the
// bounds keep a misconfiguration from feeding 0 or an absurd number of memories.
const DEFAULT_MAX_MEMORIES_PER_RUN = 200;
const MIN_MAX_MEMORIES_PER_RUN = 1;
const MAX_MAX_MEMORIES_PER_RUN = 1000;

export interface CuratorConfig {
  enabled: boolean;
  defaultAutoApply: AutoApplyLevel;
  autoApplyConfidence: number;
  /**
   * Legacy whole-minutes interval (§12.4). Retired as a cadence (D-A removed the
   * wall-clock cron); kept on the config for back-compat as the per-slice gate the
   * grooming pass still consults (retired in plan 046 T4). No longer sourced from
   * `curator.interval_minutes` (spec 045 D-8) — always the default until T4.
   */
  intervalMinutes: number;
  /**
   * Grooming wall-clock schedule (spec 045 D-3): run a full pass every this-many
   * days (positive integer; default 1 = nightly). 7 = weekly, ~30 = monthly.
   */
  intervalDays: number;
  /**
   * Grooming schedule time-of-day (spec 045 D-3): 24h `HH:MM` in the server's
   * local timezone (default "03:00"). The pass fires at this time on due days.
   */
  scheduleTime: string;
  /**
   * Post-intake threshold (spec 043 D-A): the count of memories created/augmented/
   * superseded by intake since the last groom that arms one grooming run.
   */
  triggerThreshold: number;
  /**
   * Debounce floor in whole minutes (spec 043 D-A): never auto-trigger a groom
   * within this window of the last one. Seeded from the legacy intervalMinutes.
   */
  debounceMinutes: number;
  /**
   * Bounded grooming runs (ADR 0005): the maximum active+proposed memories a
   * single grooming run feeds the model. A slice larger than this is truncated
   * (newest-first) so one oversized slice can't exceed the LLM timeout. Default
   * 200 (the prior implicit cap).
   */
  maxMemoriesPerRun: number;
}

export interface CuratorConfigPatch {
  enabled?: boolean;
  defaultAutoApply?: AutoApplyLevel;
  autoApplyConfidence?: number;
  intervalMinutes?: number;
  intervalDays?: number;
  scheduleTime?: string;
  triggerThreshold?: number;
  debounceMinutes?: number;
  maxMemoriesPerRun?: number;
}

// Input validation for the admin API. Permissive shape (all optional); the deeper
// invariants — confidence 0..1, interval ≥ 1 — are enforced by
// writeCuratorConfig, which is the single source of truth.
export const CuratorConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  defaultAutoApply: z.enum(["off", "safe_only", "high_confidence"]).optional(),
  autoApplyConfidence: z.number().optional(),
  intervalMinutes: z.number().optional(),
  intervalDays: z.number().optional(),
  scheduleTime: z.string().optional(),
  triggerThreshold: z.number().optional(),
  debounceMinutes: z.number().optional(),
  maxMemoriesPerRun: z.number().optional(),
});

// Intake's NON-LLM config surface (spec 045 D-3/D-8). Currently just the sweep
// cadence; the intake enablement flag lives in isIntakeEnabled/setIntakeEnabled and
// its provider/model/timeout in curator-consumers.ts. Kept as its own read/write
// pair (not folded into CuratorConfig, which is grooming-specific) so the two jobs'
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
// writeIntakeInterval (the single source of truth), mirroring CuratorConfigPatch.
export const IntakeConfigPatchSchema = z.strictObject({
  intervalMinutes: z.number().optional(),
});

// The slices of the store this module needs. Curator-specific keys are all plain
// (non-secret) settings; we reuse the shared reader/writer interfaces.
type ConfigReader = LlmConnectionReader;
type ConfigWriter = LlmConnectionWriter;

function parseAutoApply(raw: string | null): AutoApplyLevel {
  return AUTO_APPLY_LEVELS.includes(raw as AutoApplyLevel)
    ? (raw as AutoApplyLevel)
    : DEFAULT_AUTO_APPLY;
}

function parseNumber(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) ? n : fallback;
}

// A stored schedule time is honoured only if it's a well-formed HH:MM; a corrupt
// value falls back to the nightly default rather than producing an invalid gate.
function parseScheduleTime(raw: string | null): string {
  return raw !== null && SCHEDULE_TIME_PATTERN.test(raw) ? raw : DEFAULT_SCHEDULE_TIME;
}

export function readCuratorConfig(store: ConfigReader): CuratorConfig {
  return {
    enabled: store.getSetting(KEYS.enabled) === "true",
    defaultAutoApply: parseAutoApply(store.getSetting(KEYS.defaultAutoApply)),
    autoApplyConfidence: parseNumber(
      store.getSetting(KEYS.autoApplyConfidence),
      DEFAULT_CONFIDENCE,
    ),
    // Per-slice gate (retired in plan 046 T4): no longer sourced from the
    // `curator.interval_minutes` setting (spec 045 D-8) — held at the default.
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    intervalDays: parseNumber(store.getSetting(KEYS.intervalDays), DEFAULT_INTERVAL_DAYS),
    scheduleTime: parseScheduleTime(store.getSetting(KEYS.scheduleTime)),
    triggerThreshold: parseNumber(
      store.getSetting(KEYS.triggerThreshold),
      DEFAULT_TRIGGER_THRESHOLD,
    ),
    debounceMinutes: parseNumber(store.getSetting(KEYS.debounceMinutes), DEFAULT_DEBOUNCE_MINUTES),
    maxMemoriesPerRun: parseNumber(
      store.getSetting(KEYS.maxMemoriesPerRun),
      DEFAULT_MAX_MEMORIES_PER_RUN,
    ),
  };
}

/**
 * Returns the legacy schedule keys still present in settings (§12.4). Boot
 * code logs a one-line notice when this is non-empty so operators learn that
 * the old `min_sessions_since_run` / `interval_days` knobs are ignored.
 */
export function findLegacyScheduleKeys(store: ConfigReader): string[] {
  return LEGACY_SCHEDULE_KEYS.filter((key) => store.getSetting(key) !== null);
}

/**
 * Intake (consolidator) enablement, read from the unified `curator.intake.enabled`
 * setting (spec 043 D-E). The setting is AUTHORITATIVE once present; the legacy
 * `LIBRARIAN_CONSOLIDATOR` env var no longer gates the job — it only seeds this
 * setting on first migration and triggers a deprecation warning while still set
 * (see migrateCuratorEnablement). Default off. Reads plain settings only, so it
 * works without the master key.
 */
export function isIntakeEnabled(store: ConfigReader): boolean {
  return store.getSetting(INTAKE_ENABLED_KEY) === "true";
}

/**
 * Set intake (consolidator) enablement (spec 043 D-E / PR-5a). Writes the unified
 * `curator.intake.enabled` setting — the AUTHORITATIVE source `isIntakeEnabled`
 * reads — as the canonical "true"/"false" string, mirroring how grooming's enable
 * flag is written in `writeCuratorConfig`. This is the intake counterpart of that
 * grooming write: the unified curator dashboard's Intake toggle calls it.
 */
export function setIntakeEnabled(store: ConfigWriter, enabled: boolean): void {
  store.setSetting(INTAKE_ENABLED_KEY, enabled ? "true" : "false");
}

/**
 * Read intake's NON-LLM config — currently just the sweep cadence (spec 045 D-3).
 * Returns `intervalMinutes` from `curator.intake.interval_minutes`, defaulting to 5
 * when unset or corrupt (parseNumber falls back). Reads plain settings only, so it
 * works without the master key (the cockpit render path), like readCuratorConfig.
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
 * writeCuratorConfig's validate-then-persist style; persists under
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
 * One-time, idempotent migration that seeds the unified enablement keys from the
 * two legacy sources so an existing install keeps its EXACT enablement after the
 * 043 upgrade (spec D-E). Safe to run on every boot/tick:
 *
 *  - `curator.grooming.enabled` ← `curator.enabled` (the legacy setting), ONLY
 *    when `curator.grooming.enabled` is unset (never clobbers a value the user
 *    has since set via the dashboard) AND the legacy key is present. A fresh
 *    install with neither key leaves grooming unset → default off.
 *  - `curator.intake.enabled` ← `LIBRARIAN_CONSOLIDATOR` (on/true), ONLY when
 *    `curator.intake.enabled` is unset AND the env opts in. A fresh install or an
 *    off/absent env leaves intake unset → default off.
 *
 * Precedence in the deprecation window: the SETTING is authoritative. The env's
 * only roles are (a) seed-once here and (b) the deprecation warning emitted by
 * the boot code while the var remains set. It must NOT override the setting, so
 * toggling the dashboard off actually disables the job.
 *
 * `legacyIntakeEnv` is the raw `process.env.LIBRARIAN_CONSOLIDATOR` value, passed
 * in by the mcp-server boundary (core never reads process.env). Omitted callers
 * (e.g. the grooming tick) migrate grooming only — harmless, since intake is
 * seeded at the http boot where the env is available.
 */
export function migrateCuratorEnablement(
  store: ConfigReader & ConfigWriter,
  options: { legacyIntakeEnv?: string } = {},
): void {
  // Grooming: seed once from the legacy setting, never clobbering an explicit value.
  if (store.getSetting(GROOMING_ENABLED_KEY) === null) {
    const legacy = store.getSetting(LEGACY_GROOMING_ENABLED_KEY);
    if (legacy !== null) {
      store.setSetting(GROOMING_ENABLED_KEY, legacy === "true" ? "true" : "false");
    }
  }
  // Intake: seed once from the legacy env opt-in, never clobbering an explicit value.
  if (store.getSetting(INTAKE_ENABLED_KEY) === null) {
    const env = options.legacyIntakeEnv;
    if (env === "on" || env === "true") {
      store.setSetting(INTAKE_ENABLED_KEY, "true");
    }
  }
  // Debounce floor (spec 043 D-A): the cron is retired and curator.interval_minutes
  // is repurposed as the auto-trigger debounce. Seed curator.grooming.debounce_minutes
  // from the legacy interval ONCE so an install's existing cadence becomes its debounce
  // floor; never clobber an explicit debounce value (same seed-once/no-clobber pattern
  // as the enablement keys). A fresh install with no interval leaves debounce unset →
  // the DEFAULT_DEBOUNCE_MINUTES default.
  if (store.getSetting(KEYS.debounceMinutes) === null) {
    const legacyInterval = store.getSetting(LEGACY_INTERVAL_MINUTES_KEY);
    if (legacyInterval !== null) {
      store.setSetting(KEYS.debounceMinutes, legacyInterval);
    }
  }
}

/**
 * One-time, idempotent migration of the grooming SCHEDULE + the moved auto-apply
 * policy keys (spec 045 D-8). Mirrors `migrateCuratorEnablement`: read the old
 * key, seed the new `curator.grooming.*` key ONLY when it is unset, never clobber
 * a value the operator has since set, idempotent on re-run. Legacy keys map 1:1:
 *
 *   - `curator.default_auto_apply`        → `curator.grooming.default_auto_apply`
 *   - `curator.auto_apply_confidence`     → `curator.grooming.auto_apply_confidence`
 *   - `curator.schedule.time`             → `curator.grooming.schedule_time`
 *   - `curator.schedule.interval_days`    → `curator.grooming.interval_days`
 *
 * A fresh install with none of the legacy keys leaves the new keys unset → the
 * read-time defaults (every 1 day at 03:00, safe_only, 0.9). Run wherever
 * `migrateCuratorEnablement` runs (boot + grooming tick).
 */
export function migrateCuratorGroomingSchedule(store: ConfigReader & ConfigWriter): void {
  seedOnce(store, KEYS.defaultAutoApply, LEGACY_DEFAULT_AUTO_APPLY_KEY);
  seedOnce(store, KEYS.autoApplyConfidence, LEGACY_AUTO_APPLY_CONFIDENCE_KEY);
  seedOnce(store, KEYS.scheduleTime, LEGACY_SCHEDULE_TIME_KEY);
  seedOnce(store, KEYS.intervalDays, LEGACY_SCHEDULE_INTERVAL_DAYS_KEY);
}

// Seed `newKey` from `legacyKey` once: only when the new key is unset AND the
// legacy key is present. Never clobbers; idempotent (the second run finds the new
// key set and does nothing). Same pattern used by migrateCuratorEnablement.
function seedOnce(store: ConfigReader & ConfigWriter, newKey: string, legacyKey: string): void {
  if (store.getSetting(newKey) !== null) return;
  const legacy = store.getSetting(legacyKey);
  if (legacy !== null) store.setSetting(newKey, legacy);
}

export function writeCuratorConfig(store: ConfigWriter, patch: CuratorConfigPatch): void {
  // Validate every curator-specific field before touching the store.
  if (patch.defaultAutoApply !== undefined && !AUTO_APPLY_LEVELS.includes(patch.defaultAutoApply)) {
    throw new Error(`invalid default_auto_apply level: ${patch.defaultAutoApply}`);
  }
  if (patch.autoApplyConfidence !== undefined) {
    const c = patch.autoApplyConfidence;
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      throw new Error("auto_apply confidence must be between 0 and 1");
    }
  }
  if (patch.intervalMinutes !== undefined) {
    const m = patch.intervalMinutes;
    if (!Number.isInteger(m) || m < MIN_INTERVAL_MINUTES || m > MAX_INTERVAL_MINUTES) {
      throw new Error(
        `interval_minutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} (1 minute and one week)`,
      );
    }
  }
  if (patch.intervalDays !== undefined) {
    const d = patch.intervalDays;
    if (!Number.isInteger(d) || d < MIN_INTERVAL_DAYS) {
      throw new Error(`interval_days must be an integer >= ${MIN_INTERVAL_DAYS}`);
    }
  }
  if (patch.scheduleTime !== undefined) {
    if (!SCHEDULE_TIME_PATTERN.test(patch.scheduleTime)) {
      throw new Error("schedule_time must be HH:MM (00:00–23:59)");
    }
  }
  if (patch.triggerThreshold !== undefined) {
    const t = patch.triggerThreshold;
    if (!Number.isInteger(t) || t < MIN_TRIGGER_THRESHOLD) {
      throw new Error(`trigger_threshold must be an integer ≥ ${MIN_TRIGGER_THRESHOLD}`);
    }
  }
  if (patch.debounceMinutes !== undefined) {
    const m = patch.debounceMinutes;
    if (!Number.isInteger(m) || m < MIN_DEBOUNCE_MINUTES || m > MAX_DEBOUNCE_MINUTES) {
      throw new Error(
        `debounce_minutes must be an integer between ${MIN_DEBOUNCE_MINUTES} and ${MAX_DEBOUNCE_MINUTES} (1 minute and one week)`,
      );
    }
  }
  if (patch.maxMemoriesPerRun !== undefined) {
    const n = patch.maxMemoriesPerRun;
    if (!Number.isInteger(n) || n < MIN_MAX_MEMORIES_PER_RUN || n > MAX_MAX_MEMORIES_PER_RUN) {
      throw new Error(
        `max_memories must be an integer between ${MIN_MAX_MEMORIES_PER_RUN} and ${MAX_MAX_MEMORIES_PER_RUN}`,
      );
    }
  }

  if (patch.enabled !== undefined) store.setSetting(KEYS.enabled, patch.enabled ? "true" : "false");
  if (patch.defaultAutoApply !== undefined)
    store.setSetting(KEYS.defaultAutoApply, patch.defaultAutoApply);
  if (patch.autoApplyConfidence !== undefined)
    store.setSetting(KEYS.autoApplyConfidence, String(patch.autoApplyConfidence));
  if (patch.intervalMinutes !== undefined)
    // Still persisted to the legacy key so the debounce-seed migration
    // (migrateCuratorEnablement) has a source; no longer read for the grooming
    // cadence (spec 045 D-8) — readCuratorConfig holds intervalMinutes at default.
    store.setSetting(LEGACY_INTERVAL_MINUTES_KEY, String(patch.intervalMinutes));
  if (patch.intervalDays !== undefined)
    store.setSetting(KEYS.intervalDays, String(patch.intervalDays));
  if (patch.scheduleTime !== undefined) store.setSetting(KEYS.scheduleTime, patch.scheduleTime);
  if (patch.triggerThreshold !== undefined)
    store.setSetting(KEYS.triggerThreshold, String(patch.triggerThreshold));
  if (patch.debounceMinutes !== undefined)
    store.setSetting(KEYS.debounceMinutes, String(patch.debounceMinutes));
  if (patch.maxMemoriesPerRun !== undefined)
    store.setSetting(KEYS.maxMemoriesPerRun, String(patch.maxMemoriesPerRun));
}
