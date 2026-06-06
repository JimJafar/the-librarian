// Per-consumer LLM resolution (spec 042 §2). The two LLM-consuming curator jobs
// — `intake` (the consolidator) and `grooming` (the curator) — each reference a
// named provider (`llm-providers.ts`) by id and add their own `{ model,
// timeout_ms }`, so they can run on different models (and providers) while
// reusing one stored connection. Setting keys (042 D1, fixed now so 2B/2C don't
// re-key):
//
//   curator.<consumer>.provider    = provider id reference
//   curator.<consumer>.model       = model name
//   curator.<consumer>.timeout_ms  = per-request timeout
//
// Resolution joins the consumer's keys with the referenced provider (endpoint +
// presence-only token). A consumer whose provider was deleted resolves to
// not-operational (inert, never throws) — the caller skips it.

import { z } from "zod";
import { GROOMING_ENABLED_KEY, INTAKE_ENABLED_KEY } from "./curator-config.js";
import {
  type LlmConnectionReader,
  type LlmConnectionWriter,
  llmConnectionKeys,
  resolveLlmToken,
} from "./llm-connection.js";
import {
  addProvider,
  getProvider,
  listProviderIds,
  resolveProviderToken,
} from "./llm-providers.js";

// The two scheduled/triggered curator JOBS that consume an LLM. This is the
// job-iteration type AND list: enablement (`curator.<job>.enabled`), the legacy
// migration, the addendum files, and the schedulers all key off it. Adding a new
// member here makes the codebase treat it as a runnable job — do NOT add `chat`.
export type CuratorConsumer = "intake" | "grooming";
export const CURATOR_CONSUMERS: readonly CuratorConsumer[] = ["intake", "grooming"];

// The CONFIG-ONLY superset of LLM consumers (spec 044 D-8). `chat` is the
// interactive curator chat endpoint's LLM (D6b) — it has its OWN
// `curator.chat.{provider,model,timeout_ms}` config but, unlike the two jobs, NO
// enablement key, NO legacy migration, and NO scheduler. It is deliberately a
// SEPARATE type from `CuratorConsumer` (not a widening) so the job-only paths —
// `enabledKey`, `migrateLegacyCuratorLlm`'s `CURATOR_CONSUMERS` loop, the
// addendum store methods — stay typed to jobs and can never silently start
// treating `chat` as a job. Only the per-consumer config surface
// (`readConsumerConfig` / `writeConsumerConfig` / `resolveConsumerToken`) widens
// to `LlmConsumer`.
export type LlmConsumer = CuratorConsumer | "chat";

// When the `chat` consumer's own config is unset, it resolves WHOLE-CONSUMER from
// this job's config (spec 044 D-8): provider + model + token + timeout. Set
// chat's own provider to override the fallback entirely.
const CHAT_FALLBACK_CONSUMER: CuratorConsumer = "grooming";

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

export interface ConsumerConfig {
  consumer: LlmConsumer;
  /**
   * Whether this job is enabled, from the unified `curator.<consumer>.enabled`
   * setting (spec 043 D-E). Default off. The setting is authoritative; the
   * legacy sources (curator.enabled / LIBRARIAN_CONSOLIDATOR) only seed it once
   * via migrateCuratorEnablement. ALWAYS `false` for the config-only `chat`
   * consumer — it is not a job and has no enablement key.
   */
  enabled: boolean;
  /** Referenced provider id; "" when unset. */
  providerId: string;
  /** Whether `providerId` resolves to an existing provider. */
  providerExists: boolean;
  /** The resolved provider's endpoint; "" when the provider is missing. */
  endpoint: string;
  model: string;
  timeoutMs: number;
  /** The resolved provider exists AND has a token stored. */
  hasToken: boolean;
  /** providerExists && hasToken && model set — the resolution a tick needs to run. */
  isOperational: boolean;
}

export interface ConsumerConfigPatch {
  enabled?: boolean;
  providerId?: string;
  model?: string;
  timeoutMs?: number;
}

// Permissive admin-patch shape; the timeout bound is enforced in
// `writeConsumerConfig`, the single source of truth.
export const ConsumerConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().optional(),
});

type ConsumerReader = LlmConnectionReader;
type ConsumerStore = LlmConnectionReader & LlmConnectionWriter;

interface ConsumerKeys {
  provider: string;
  model: string;
  timeoutMs: string;
}

function consumerKeys(consumer: LlmConsumer): ConsumerKeys {
  const prefix = `curator.${consumer}`;
  return {
    provider: `${prefix}.provider`,
    model: `${prefix}.model`,
    timeoutMs: `${prefix}.timeout_ms`,
  };
}

// The unified enablement key for a consumer (`curator.<consumer>.enabled`,
// spec 043 D-E). Kept as fixed constants in curator-config.ts so the migration,
// the http gate, and this per-consumer surface all agree.
function enabledKey(consumer: CuratorConsumer): string {
  return consumer === "intake" ? INTAKE_ENABLED_KEY : GROOMING_ENABLED_KEY;
}

// Bounded timeout parse: a valid in-range integer, else undefined. The read path
// defaults; the migration omits (lets the consumer default). Clamping on read
// means a hand-edited vault value can never feed a tick a 0/negative timeout.
function boundedTimeout(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_TIMEOUT_MS && n <= MAX_TIMEOUT_MS ? n : undefined;
}

function parseTimeoutMs(raw: string | null): number {
  return boundedTimeout(raw) ?? DEFAULT_TIMEOUT_MS;
}

/**
 * Read a consumer's resolved config, joined with its referenced provider. Never
 * throws.
 *
 * The config-only `chat` consumer (spec 044 D-8) falls back WHOLE-CONSUMER to the
 * grooming consumer when its OWN provider is unset: with no `curator.chat.provider`
 * set, chat resolves entirely from grooming (provider + model + timeout, and
 * `resolveConsumerToken` mirrors this). Once chat's own provider IS set, chat's
 * own model/timeout/token win — there is no per-field mixing. `chat` is never a
 * job, so its resolved `enabled` is always `false`.
 */
export function readConsumerConfig(store: ConsumerReader, consumer: LlmConsumer): ConsumerConfig {
  // chat with no own provider configured -> resolve the grooming consumer instead,
  // but keep `consumer: "chat"` so the caller knows which config it requested.
  if (consumer === "chat" && (store.getSetting(consumerKeys("chat").provider) ?? "") === "") {
    return {
      ...readConsumerConfig(store, CHAT_FALLBACK_CONSUMER),
      consumer: "chat",
      enabled: false,
    };
  }

  const keys = consumerKeys(consumer);
  // `chat` has no enablement key (it is not a job) -> always false.
  const enabled = consumer !== "chat" && store.getSetting(enabledKey(consumer)) === "true";
  const providerId = store.getSetting(keys.provider) ?? "";
  const model = store.getSetting(keys.model) ?? "";
  const timeoutMs = parseTimeoutMs(store.getSetting(keys.timeoutMs));
  const provider = providerId ? getProvider(store, providerId) : null;
  const providerExists = provider !== null;
  const hasToken = provider?.hasToken ?? false;
  return {
    consumer,
    enabled,
    providerId,
    providerExists,
    endpoint: provider?.endpoint ?? "",
    model,
    timeoutMs,
    hasToken,
    isOperational: providerExists && hasToken && model !== "",
  };
}

/**
 * Patch a consumer's provider/model/timeout. Validates the timeout bound. The
 * config-only `chat` consumer has NO enablement key (it is not a job), so a
 * `patch.enabled` for `chat` is rejected — chat can never be enabled/disabled.
 */
export function writeConsumerConfig(
  store: ConsumerStore,
  consumer: LlmConsumer,
  patch: ConsumerConfigPatch,
): void {
  if (patch.timeoutMs !== undefined) {
    const t = patch.timeoutMs;
    if (!Number.isInteger(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) {
      throw new Error(
        `curator.${consumer}.timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (1s and 10min)`,
      );
    }
  }
  const keys = consumerKeys(consumer);
  if (patch.enabled !== undefined) {
    if (consumer === "chat") {
      throw new Error("curator.chat has no enablement — chat is an endpoint, not a job");
    }
    store.setSetting(enabledKey(consumer), patch.enabled ? "true" : "false");
  }
  if (patch.providerId !== undefined) store.setSetting(keys.provider, patch.providerId);
  if (patch.model !== undefined) store.setSetting(keys.model, patch.model);
  if (patch.timeoutMs !== undefined) store.setSetting(keys.timeoutMs, String(patch.timeoutMs));
}

/**
 * Decrypt the token of the provider a consumer references. Null when
 * unset/missing. Needs the master key.
 *
 * Mirrors `readConsumerConfig`'s grooming fallback for `chat` (spec 044 D-8): an
 * unconfigured chat consumer resolves grooming's token, so the chat endpoint runs
 * on grooming's provider until it is given its own.
 */
export function resolveConsumerToken(store: ConsumerReader, consumer: LlmConsumer): string | null {
  const target =
    consumer === "chat" && (store.getSetting(consumerKeys("chat").provider) ?? "") === ""
      ? CHAT_FALLBACK_CONSUMER
      : consumer;
  const providerId = store.getSetting(consumerKeys(target).provider) ?? "";
  if (!providerId) return null;
  return resolveProviderToken(store, providerId);
}

/**
 * One-shot migration of a pre-existing `curator.llm.*` install: synthesise a
 * `default` provider from the legacy endpoint/token and point both consumers at
 * it with the legacy model + timeout, then delete the legacy keys. Idempotent —
 * a no-op once any provider exists or the legacy keys are gone. Returns whether
 * it migrated.
 *
 * Deletion fires ONLY on the confirmed-success path — after the new provider +
 * consumer config have been seeded. Every early `return false` (no providers
 * needed, no endpoint, master key absent) bails out BEFORE any seed, so the
 * legacy keys survive a deferral intact and no data is lost. NEVER delete before
 * seeding or on the defer path.
 */
export function migrateLegacyCuratorLlm(store: ConsumerStore): boolean {
  if (listProviderIds(store).length > 0) return false;

  const legacy = llmConnectionKeys("curator.llm");
  const endpoint = (store.getSetting(legacy.endpoint) ?? "").trim();
  if (!endpoint) return false; // nothing meaningful to migrate without an endpoint

  const model = store.getSetting(legacy.model) ?? "";
  let token: string | null;
  try {
    token = resolveLlmToken(store, legacy);
  } catch {
    // A legacy token exists but the master key is absent, so it can't be read to
    // re-encrypt under the new provider. Defer the whole migration (retry next
    // tick when the key is back) rather than half-migrate a token-less provider —
    // migration is one-shot, so that would permanently drop the key. Fail-soft:
    // never throw out of a tick. The legacy keys are left untouched here.
    return false;
  }
  const created = addProvider(store, {
    name: "default",
    endpoint,
    ...(token ? { token } : {}),
  });

  const timeoutMs = boundedTimeout(store.getSetting(legacy.timeoutMs));
  for (const consumer of CURATOR_CONSUMERS) {
    writeConsumerConfig(store, consumer, {
      providerId: created.id,
      model,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  // Seed succeeded: retire the legacy `curator.llm.*` surface so it can't become
  // a stale second source of truth. Safe to delete now — we've already read +
  // re-encrypted the token under the new provider. Keeps the migration
  // idempotent (a re-run finds nothing to migrate).
  for (const key of Object.values(legacy)) store.deleteSetting(key);
  return true;
}
