// Curator LLM configuration (memory-curator spec §7.1), stored in the admin
// settings/secret store. Operator-managed: enable flag, LLM connection
// (provider/endpoint/token/model), prompt addendum, auto-apply posture, and
// schedule. The token is a secret (encrypted by the settings store); the
// readable config exposes only `hasToken`, never the value.
//
// `readCuratorConfig` deliberately reads token PRESENCE from settings metadata
// (no decryption), so it works without the master key — the admin cockpit can
// render the configured state. Only the worker's `resolveCuratorToken` decrypts.

import { z } from "zod";
import {
  type LlmConnectionPatch,
  type LlmConnectionReader,
  type LlmConnectionWriter,
  LlmConnectionPatchSchema,
  llmConnectionKeys,
  readLlmConnection,
  resolveLlmToken,
  writeLlmConnection,
} from "./llm-connection.js";

// LLM-connection keys delegate to the shared helper (`curator.llm.*`);
// curator-specific keys (enable flag, prompt addendum, auto-apply, schedule)
// stay inline here.
const LLM_KEYS = llmConnectionKeys("curator.llm");
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
  llm: { provider: string; endpoint: string; model: string; timeoutMs: number };
  /** Whether an LLM token is stored — never the value. */
  hasToken: boolean;
  promptAddendum: string;
  defaultAutoApply: AutoApplyLevel;
  autoApplyConfidence: number;
  /** Whole minutes between scheduled runs (§12.4). */
  intervalMinutes: number;
  /** provider + endpoint + model + token all present. */
  isLlmComplete: boolean;
  /** enabled AND the LLM config is complete (§7.1 — the scheduler gate). */
  isOperational: boolean;
}

export interface CuratorConfigPatch {
  enabled?: boolean;
  llm?: { provider?: string; endpoint?: string; model?: string; timeoutMs?: number };
  /** Plaintext token; stored encrypted. Empty string clears it. */
  token?: string;
  promptAddendum?: string;
  defaultAutoApply?: AutoApplyLevel;
  autoApplyConfidence?: number;
  intervalMinutes?: number;
}

// Input validation for the admin API. Permissive shape (all optional); the deeper
// invariants — addendum ≤ 2 KB, confidence 0..1, interval ≥ 1, HH:MM — are
// enforced by writeCuratorConfig, which is the single source of truth.
export const CuratorConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  llm: LlmConnectionPatchSchema.optional(),
  token: z.string().optional(),
  promptAddendum: z.string().optional(),
  defaultAutoApply: z.enum(["off", "safe_only", "high_confidence"]).optional(),
  autoApplyConfidence: z.number().optional(),
  intervalMinutes: z.number().optional(),
});

// The slices of the store this module needs. The LLM-connection block uses
// the helper's reader/writer interfaces; curator-specific keys reuse the
// same slice (it's a superset).
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
  const llm = readLlmConnection(store, LLM_KEYS);
  const enabled = store.getSetting(KEYS.enabled) === "true";
  return {
    enabled,
    llm: {
      provider: llm.provider,
      endpoint: llm.endpoint,
      model: llm.model,
      timeoutMs: llm.timeoutMs,
    },
    hasToken: llm.hasToken,
    promptAddendum: store.getSetting(KEYS.promptAddendum) ?? "",
    defaultAutoApply: parseAutoApply(store.getSetting(KEYS.defaultAutoApply)),
    autoApplyConfidence: parseNumber(
      store.getSetting(KEYS.autoApplyConfidence),
      DEFAULT_CONFIDENCE,
    ),
    intervalMinutes: parseNumber(store.getSetting(KEYS.intervalMinutes), DEFAULT_INTERVAL_MINUTES),
    isLlmComplete: llm.isComplete,
    isOperational: enabled && llm.isComplete,
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
  // Validate every curator-specific field before touching the store. The
  // LLM-connection block is validated inside `writeLlmConnection`.
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

  // LLM-connection block + token go through the shared helper, which validates
  // timeoutMs bounds and encrypts the token.
  if (patch.llm !== undefined || patch.token !== undefined) {
    const llmPatch: LlmConnectionPatch & { token?: string } = { ...(patch.llm ?? {}) };
    if (patch.token !== undefined) llmPatch.token = patch.token;
    writeLlmConnection(store, LLM_KEYS, llmPatch);
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

/** Decrypt the stored LLM token for the worker. Returns null when unset. Needs the master key. */
export function resolveCuratorToken(store: {
  getSetting: (key: string) => string | null;
}): string | null {
  return resolveLlmToken(store, LLM_KEYS);
}
