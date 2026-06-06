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
const KEYS = {
  enabled: "curator.enabled",
  promptAddendum: "curator.prompt_addendum",
  defaultAutoApply: "curator.default_auto_apply",
  autoApplyConfidence: "curator.auto_apply_confidence",
  intervalMinutes: "curator.interval_minutes",
} as const;

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
