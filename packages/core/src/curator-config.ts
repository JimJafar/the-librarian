// Curator configuration (memory-curator spec §7.1), stored in the admin
// settings store. Operator-managed: enable flag, prompt addendum, auto-apply
// posture, and schedule. The LLM connection no longer lives here — providers are
// named + dashboard-managed (`llm-providers.ts`) and each consumer (intake /
// grooming) picks its own provider+model (`curator-consumers.ts`). This config
// carries only the curator's NON-LLM knobs.
//
// `readCuratorConfig` reads plain settings only, so it works without the master
// key — the admin cockpit can always render the configured state.

import { z } from "zod";
import type { LlmConnectionReader, LlmConnectionWriter } from "./llm-connection.js";

// Curator-specific keys (enable flag, prompt addendum, auto-apply, schedule).
// Grooming's enablement now lives under the unified `curator.grooming.enabled`
// key (spec 043 D-E); the legacy `curator.enabled` is read once at migration
// time and never again (see migrateCuratorEnablement / LEGACY_GROOMING_ENABLED_KEY).
const KEYS = {
  enabled: "curator.grooming.enabled",
  promptAddendum: "curator.prompt_addendum",
  defaultAutoApply: "curator.default_auto_apply",
  autoApplyConfidence: "curator.auto_apply_confidence",
  intervalMinutes: "curator.interval_minutes",
} as const;

// Unified curator enablement keys (spec 043 D-E). BOTH jobs' on/off flags now
// live under the `curator.*` namespace as dashboard-editable string settings
// ("true"/"false"), replacing the two legacy sources:
//   grooming: curator.enabled            (a setting)  → curator.grooming.enabled
//   intake:   LIBRARIAN_CONSOLIDATOR env (an env var) → curator.intake.enabled
export const GROOMING_ENABLED_KEY = "curator.grooming.enabled";
export const INTAKE_ENABLED_KEY = "curator.intake.enabled";

// The pre-043 grooming enablement setting. Read ONLY by migrateCuratorEnablement
// to seed the new key once; the scheduler never reads it again.
export const LEGACY_GROOMING_ENABLED_KEY = "curator.enabled";

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
const MAX_ADDENDUM_BYTES = 2048; // §7.1: addendum is length-bounded (~2 KB)

// Spec defaults (§7.2 / §12.4).
const DEFAULT_AUTO_APPLY: AutoApplyLevel = "safe_only";
const DEFAULT_CONFIDENCE = 0.9;
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60; // one week

export interface CuratorConfig {
  enabled: boolean;
  promptAddendum: string;
  defaultAutoApply: AutoApplyLevel;
  autoApplyConfidence: number;
  /** Whole minutes between scheduled runs (§12.4). */
  intervalMinutes: number;
}

export interface CuratorConfigPatch {
  enabled?: boolean;
  promptAddendum?: string;
  defaultAutoApply?: AutoApplyLevel;
  autoApplyConfidence?: number;
  intervalMinutes?: number;
}

// Input validation for the admin API. Permissive shape (all optional); the deeper
// invariants — addendum ≤ 2 KB, confidence 0..1, interval ≥ 1 — are enforced by
// writeCuratorConfig, which is the single source of truth.
export const CuratorConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  promptAddendum: z.string().optional(),
  defaultAutoApply: z.enum(["off", "safe_only", "high_confidence"]).optional(),
  autoApplyConfidence: z.number().optional(),
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

export function readCuratorConfig(store: ConfigReader): CuratorConfig {
  return {
    enabled: store.getSetting(KEYS.enabled) === "true",
    promptAddendum: store.getSetting(KEYS.promptAddendum) ?? "",
    defaultAutoApply: parseAutoApply(store.getSetting(KEYS.defaultAutoApply)),
    autoApplyConfidence: parseNumber(
      store.getSetting(KEYS.autoApplyConfidence),
      DEFAULT_CONFIDENCE,
    ),
    intervalMinutes: parseNumber(store.getSetting(KEYS.intervalMinutes), DEFAULT_INTERVAL_MINUTES),
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
}

export function writeCuratorConfig(store: ConfigWriter, patch: CuratorConfigPatch): void {
  // Validate every curator-specific field before touching the store.
  if (patch.promptAddendum !== undefined) {
    if (Buffer.byteLength(patch.promptAddendum, "utf8") > MAX_ADDENDUM_BYTES) {
      throw new Error(`prompt addendum must be ≤ ${MAX_ADDENDUM_BYTES} bytes (~2 KB)`);
    }
  }
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

  if (patch.enabled !== undefined) store.setSetting(KEYS.enabled, patch.enabled ? "true" : "false");
  if (patch.promptAddendum !== undefined)
    store.setSetting(KEYS.promptAddendum, patch.promptAddendum);
  if (patch.defaultAutoApply !== undefined)
    store.setSetting(KEYS.defaultAutoApply, patch.defaultAutoApply);
  if (patch.autoApplyConfidence !== undefined)
    store.setSetting(KEYS.autoApplyConfidence, String(patch.autoApplyConfidence));
  if (patch.intervalMinutes !== undefined)
    store.setSetting(KEYS.intervalMinutes, String(patch.intervalMinutes));
}
