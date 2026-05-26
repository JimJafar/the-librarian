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
import type { SettingMeta } from "./store/settings-store.js";

const KEYS = {
  enabled: "curator.enabled",
  provider: "curator.llm.provider",
  endpoint: "curator.llm.endpoint",
  model: "curator.llm.model",
  llmTimeoutMs: "curator.llm.timeout_ms",
  token: "curator.llm.token",
  promptAddendum: "curator.prompt_addendum",
  defaultAutoApply: "curator.default_auto_apply",
  autoApplyConfidence: "curator.auto_apply_confidence",
  scheduleIntervalDays: "curator.schedule.interval_days",
  scheduleTime: "curator.schedule.time",
} as const;

export type AutoApplyLevel = "off" | "safe_only" | "high_confidence";
const AUTO_APPLY_LEVELS: readonly AutoApplyLevel[] = ["off", "safe_only", "high_confidence"];
const MAX_ADDENDUM_BYTES = 2048; // §7.1: addendum is length-bounded (~2 KB)

// Spec defaults (§7.2 / §12).
const DEFAULT_AUTO_APPLY: AutoApplyLevel = "safe_only";
const DEFAULT_CONFIDENCE = 0.9;
const DEFAULT_INTERVAL_DAYS = 1;
const DEFAULT_TIME = "03:00";
// Curator LLM request timeout — matches `curator-llm-client`'s DEFAULT_TIMEOUT_MS.
// Operator-configurable so a slow provider (especially a self-hosted model on
// modest hardware) doesn't time out mid-batch with an `llm_timeout` error.
const DEFAULT_LLM_TIMEOUT_MS = 60_000;
const MIN_LLM_TIMEOUT_MS = 1_000;
const MAX_LLM_TIMEOUT_MS = 600_000;

export interface CuratorConfig {
  enabled: boolean;
  llm: { provider: string; endpoint: string; model: string; timeoutMs: number };
  /** Whether an LLM token is stored — never the value. */
  hasToken: boolean;
  promptAddendum: string;
  defaultAutoApply: AutoApplyLevel;
  autoApplyConfidence: number;
  schedule: { intervalDays: number; time: string };
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
  schedule?: { intervalDays?: number; time?: string };
}

// Input validation for the admin API. Permissive shape (all optional); the deeper
// invariants — addendum ≤ 2 KB, confidence 0..1, interval ≥ 1, HH:MM — are
// enforced by writeCuratorConfig, which is the single source of truth.
export const CuratorConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  llm: z
    .strictObject({
      provider: z.string().optional(),
      endpoint: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().optional(),
    })
    .optional(),
  token: z.string().optional(),
  promptAddendum: z.string().optional(),
  defaultAutoApply: z.enum(["off", "safe_only", "high_confidence"]).optional(),
  autoApplyConfidence: z.number().optional(),
  schedule: z
    .strictObject({ intervalDays: z.number().optional(), time: z.string().optional() })
    .optional(),
});

// The slices of the store this module needs.
interface ConfigReader {
  getSetting: (key: string) => string | null;
  listSettings: () => SettingMeta[];
}
interface ConfigWriter {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  deleteSetting: (key: string) => void;
}

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
  const provider = store.getSetting(KEYS.provider) ?? "";
  const endpoint = store.getSetting(KEYS.endpoint) ?? "";
  const model = store.getSetting(KEYS.model) ?? "";
  const hasToken = store.listSettings().some((setting) => setting.key === KEYS.token);
  const enabled = store.getSetting(KEYS.enabled) === "true";

  const timeoutMs = parseNumber(store.getSetting(KEYS.llmTimeoutMs), DEFAULT_LLM_TIMEOUT_MS);
  const isLlmComplete = Boolean(provider && endpoint && model && hasToken);
  return {
    enabled,
    llm: { provider, endpoint, model, timeoutMs },
    hasToken,
    promptAddendum: store.getSetting(KEYS.promptAddendum) ?? "",
    defaultAutoApply: parseAutoApply(store.getSetting(KEYS.defaultAutoApply)),
    autoApplyConfidence: parseNumber(
      store.getSetting(KEYS.autoApplyConfidence),
      DEFAULT_CONFIDENCE,
    ),
    schedule: {
      intervalDays: parseNumber(store.getSetting(KEYS.scheduleIntervalDays), DEFAULT_INTERVAL_DAYS),
      time: store.getSetting(KEYS.scheduleTime) ?? DEFAULT_TIME,
    },
    isLlmComplete,
    isOperational: enabled && isLlmComplete,
  };
}

export function writeCuratorConfig(store: ConfigWriter, patch: CuratorConfigPatch): void {
  // Validate everything before writing anything (a bad patch makes no change).
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
  if (patch.schedule?.intervalDays !== undefined) {
    const d = patch.schedule.intervalDays;
    if (!Number.isInteger(d) || d < 1) {
      throw new Error("schedule interval_days must be a positive integer");
    }
  }
  if (
    patch.schedule?.time !== undefined &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.schedule.time)
  ) {
    throw new Error("schedule time must be HH:MM (24-hour)");
  }
  if (patch.llm?.timeoutMs !== undefined) {
    const t = patch.llm.timeoutMs;
    if (!Number.isInteger(t) || t < MIN_LLM_TIMEOUT_MS || t > MAX_LLM_TIMEOUT_MS) {
      throw new Error(
        `llm timeout_ms must be an integer between ${MIN_LLM_TIMEOUT_MS} and ${MAX_LLM_TIMEOUT_MS} (1s and 10min)`,
      );
    }
  }

  if (patch.enabled !== undefined) store.setSetting(KEYS.enabled, patch.enabled ? "true" : "false");
  if (patch.llm?.provider !== undefined) store.setSetting(KEYS.provider, patch.llm.provider);
  if (patch.llm?.endpoint !== undefined) store.setSetting(KEYS.endpoint, patch.llm.endpoint);
  if (patch.llm?.model !== undefined) store.setSetting(KEYS.model, patch.llm.model);
  if (patch.llm?.timeoutMs !== undefined)
    store.setSetting(KEYS.llmTimeoutMs, String(patch.llm.timeoutMs));
  if (patch.token !== undefined) {
    if (patch.token === "") store.deleteSetting(KEYS.token);
    else store.setSetting(KEYS.token, patch.token, { secret: true });
  }
  if (patch.promptAddendum !== undefined)
    store.setSetting(KEYS.promptAddendum, patch.promptAddendum);
  if (patch.defaultAutoApply !== undefined)
    store.setSetting(KEYS.defaultAutoApply, patch.defaultAutoApply);
  if (patch.autoApplyConfidence !== undefined)
    store.setSetting(KEYS.autoApplyConfidence, String(patch.autoApplyConfidence));
  if (patch.schedule?.intervalDays !== undefined)
    store.setSetting(KEYS.scheduleIntervalDays, String(patch.schedule.intervalDays));
  if (patch.schedule?.time !== undefined) store.setSetting(KEYS.scheduleTime, patch.schedule.time);
}

/** Decrypt the stored LLM token for the worker. Returns null when unset. Needs the master key. */
export function resolveCuratorToken(store: {
  getSetting: (key: string) => string | null;
}): string | null {
  return store.getSetting(KEYS.token);
}
