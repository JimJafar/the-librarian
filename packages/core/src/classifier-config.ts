// Classifier admin config (classifier-implementation §4.2, retiring the
// env contract documented there in favour of admin-settings persistence).
// Mirrors curator-config.ts: the LLM connection block delegates to the
// shared `llm-connection` helper; classifier-specific fields (enable flag,
// provider mode, local-model knobs, prompt version) stay inline.
//
// Reads never include the token plaintext — only `hasToken` (from settings
// metadata). Only `resolveClassifierToken` decrypts. `classifierConfigHash`
// builds a stable digest the boot path stores alongside the running worker
// so the dashboard can detect drift between stored and running config.

import { createHash } from "node:crypto";
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

const LLM_KEYS = llmConnectionKeys("classifier.llm");
const KEYS = {
  enabled: "classifier.enabled",
  providerMode: "classifier.provider_mode",
  localModelId: "classifier.local.model_id",
  localQuant: "classifier.local.quant",
  promptVersion: "classifier.prompt_version",
} as const;

// LIBRARIAN_CLASSIFIER_* env vars that the env-contract era used.
// `findLegacyClassifierEnvKeys` returns those still set in the process
// environment after the retirement so boot can emit a notice.
export const LEGACY_CLASSIFIER_ENV_KEYS = [
  "LIBRARIAN_CLASSIFIER_ENABLED",
  "LIBRARIAN_CLASSIFIER_PROVIDER",
  "LIBRARIAN_CLASSIFIER_REMOTE_ENDPOINT",
  "LIBRARIAN_CLASSIFIER_REMOTE_TOKEN",
  "LIBRARIAN_CLASSIFIER_REMOTE_MODEL",
  "LIBRARIAN_CLASSIFIER_LOCAL_MODEL",
  "LIBRARIAN_CLASSIFIER_LOCAL_QUANT",
] as const;

export type ProviderMode = "remote" | "local";
const PROVIDER_MODES: readonly ProviderMode[] = ["remote", "local"];

// Defaults — keep parity with the env-contract semantics: classifier
// disabled until an admin opts in.
const DEFAULT_PROVIDER_MODE: ProviderMode = "remote";

// Prompt versions follow `v1`, `v2`, … (see packages/classifier/src/prompts/).
const PROMPT_VERSION_RE = /^v\d+$/;

export interface ClassifierConfig {
  enabled: boolean;
  providerMode: ProviderMode;
  llm: { provider: string; endpoint: string; model: string; timeoutMs: number };
  /** Whether an LLM token is stored — never the value. */
  hasToken: boolean;
  /** provider + endpoint + model + token all present (remote mode). */
  isLlmComplete: boolean;
  local: { modelId: string; quant: string | null };
  /** Null when unset (the classifier package uses its default). */
  promptVersion: string | null;
  /**
   * Provider-mode branch:
   *   - remote: `enabled && isLlmComplete`
   *   - local:  `enabled && local.modelId !== ""`
   */
  isOperational: boolean;
}

export interface ClassifierConfigPatch {
  enabled?: boolean;
  providerMode?: ProviderMode;
  llm?: LlmConnectionPatch;
  /** Plaintext token; stored encrypted. Empty string clears it. */
  token?: string;
  local?: { modelId?: string; quant?: string | null };
  /** Pass `null` to clear; otherwise must match /^v\d+$/. */
  promptVersion?: string | null;
}

// Admin tRPC boundary validation. Strict shape; deeper invariants
// (provider-mode enum, promptVersion regex, timeout bounds) are enforced
// inside `writeClassifierConfig` and the shared LLM helper.
export const ClassifierConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  providerMode: z.enum(["remote", "local"]).optional(),
  llm: LlmConnectionPatchSchema.optional(),
  token: z.string().optional(),
  local: z
    .strictObject({
      modelId: z.string().optional(),
      quant: z.string().nullable().optional(),
    })
    .optional(),
  promptVersion: z.string().nullable().optional(),
});

type ConfigReader = LlmConnectionReader;
type ConfigWriter = LlmConnectionWriter;

function parseProviderMode(raw: string | null): ProviderMode {
  return PROVIDER_MODES.includes(raw as ProviderMode)
    ? (raw as ProviderMode)
    : DEFAULT_PROVIDER_MODE;
}

export function readClassifierConfig(store: ConfigReader): ClassifierConfig {
  const llm = readLlmConnection(store, LLM_KEYS);
  const enabled = store.getSetting(KEYS.enabled) === "true";
  const providerMode = parseProviderMode(store.getSetting(KEYS.providerMode));
  const localModelId = store.getSetting(KEYS.localModelId) ?? "";
  const localQuant = store.getSetting(KEYS.localQuant);
  const promptVersion = store.getSetting(KEYS.promptVersion);
  const isOperational =
    enabled && (providerMode === "remote" ? llm.isComplete : localModelId !== "");
  return {
    enabled,
    providerMode,
    llm: {
      provider: llm.provider,
      endpoint: llm.endpoint,
      model: llm.model,
      timeoutMs: llm.timeoutMs,
    },
    hasToken: llm.hasToken,
    isLlmComplete: llm.isComplete,
    local: { modelId: localModelId, quant: localQuant },
    promptVersion,
    isOperational,
  };
}

export function writeClassifierConfig(store: ConfigWriter, patch: ClassifierConfigPatch): void {
  // Validate every classifier-specific field before touching the store.
  // The LLM-connection block is validated inside `writeLlmConnection`.
  if (patch.providerMode !== undefined && !PROVIDER_MODES.includes(patch.providerMode)) {
    throw new Error(`invalid provider mode: ${patch.providerMode}`);
  }
  if (patch.promptVersion !== undefined && patch.promptVersion !== null) {
    if (!PROMPT_VERSION_RE.test(patch.promptVersion)) {
      throw new Error(`prompt version must match /^v\\d+$/, got: ${patch.promptVersion}`);
    }
  }

  // LLM-connection block + token go through the shared helper.
  if (patch.llm !== undefined || patch.token !== undefined) {
    const llmPatch: LlmConnectionPatch & { token?: string } = { ...(patch.llm ?? {}) };
    if (patch.token !== undefined) llmPatch.token = patch.token;
    writeLlmConnection(store, LLM_KEYS, llmPatch);
  }

  if (patch.enabled !== undefined) store.setSetting(KEYS.enabled, patch.enabled ? "true" : "false");
  if (patch.providerMode !== undefined) store.setSetting(KEYS.providerMode, patch.providerMode);
  if (patch.local?.modelId !== undefined) store.setSetting(KEYS.localModelId, patch.local.modelId);
  if (patch.local?.quant !== undefined) {
    if (patch.local.quant === null) store.deleteSetting(KEYS.localQuant);
    else store.setSetting(KEYS.localQuant, patch.local.quant);
  }
  if (patch.promptVersion !== undefined) {
    if (patch.promptVersion === null) store.deleteSetting(KEYS.promptVersion);
    else store.setSetting(KEYS.promptVersion, patch.promptVersion);
  }
}

/** Decrypt the stored LLM token. Returns null when unset. Needs the master key. */
export function resolveClassifierToken(store: {
  getSetting: (key: string) => string | null;
}): string | null {
  return resolveLlmToken(store, LLM_KEYS);
}

/**
 * Stable SHA-256 over the canonical JSON of the classifier config.
 *
 * The token plaintext is NEVER part of the hashed payload — we hash a
 * sha256 fingerprint of the encrypted blob stored under
 * `classifier.llm.token`. That preserves the rotation-detection
 * property (any change to the encrypted value flips the hash) without
 * ever touching the plaintext or requiring the master key.
 */
export function classifierConfigHash(store: ConfigReader): string {
  const cfg = readClassifierConfig(store);
  const encryptedToken = store.getSetting(LLM_KEYS.token) ?? "";
  const tokenFingerprint = createHash("sha256").update(encryptedToken).digest("hex");
  const canonical = JSON.stringify({
    enabled: cfg.enabled,
    providerMode: cfg.providerMode,
    llm: {
      provider: cfg.llm.provider,
      endpoint: cfg.llm.endpoint,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    },
    local: cfg.local,
    promptVersion: cfg.promptVersion,
    tokenFingerprint,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Returns the retired `LIBRARIAN_CLASSIFIER_*` env keys that are still
 * set with a non-empty value in `env`, in declaration order. Boot logs a
 * one-line notice when this is non-empty so operators learn the env
 * contract is gone.
 */
export function findLegacyClassifierEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return LEGACY_CLASSIFIER_ENV_KEYS.filter((key) => {
    const value = env[key];
    return value !== undefined && value !== "";
  });
}
