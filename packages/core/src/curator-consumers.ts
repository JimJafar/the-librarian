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

export type CuratorConsumer = "intake" | "grooming";
export const CURATOR_CONSUMERS: readonly CuratorConsumer[] = ["intake", "grooming"];

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

export interface ConsumerConfig {
  consumer: CuratorConsumer;
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
  providerId?: string;
  model?: string;
  timeoutMs?: number;
}

// Permissive admin-patch shape; the timeout bound is enforced in
// `writeConsumerConfig`, the single source of truth.
export const ConsumerConfigPatchSchema = z.strictObject({
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

function consumerKeys(consumer: CuratorConsumer): ConsumerKeys {
  const prefix = `curator.${consumer}`;
  return {
    provider: `${prefix}.provider`,
    model: `${prefix}.model`,
    timeoutMs: `${prefix}.timeout_ms`,
  };
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

/** Read a consumer's resolved config, joined with its referenced provider. Never throws. */
export function readConsumerConfig(
  store: ConsumerReader,
  consumer: CuratorConsumer,
): ConsumerConfig {
  const keys = consumerKeys(consumer);
  const providerId = store.getSetting(keys.provider) ?? "";
  const model = store.getSetting(keys.model) ?? "";
  const timeoutMs = parseTimeoutMs(store.getSetting(keys.timeoutMs));
  const provider = providerId ? getProvider(store, providerId) : null;
  const providerExists = provider !== null;
  const hasToken = provider?.hasToken ?? false;
  return {
    consumer,
    providerId,
    providerExists,
    endpoint: provider?.endpoint ?? "",
    model,
    timeoutMs,
    hasToken,
    isOperational: providerExists && hasToken && model !== "",
  };
}

/** Patch a consumer's provider/model/timeout. Validates the timeout bound. */
export function writeConsumerConfig(
  store: ConsumerStore,
  consumer: CuratorConsumer,
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
  if (patch.providerId !== undefined) store.setSetting(keys.provider, patch.providerId);
  if (patch.model !== undefined) store.setSetting(keys.model, patch.model);
  if (patch.timeoutMs !== undefined) store.setSetting(keys.timeoutMs, String(patch.timeoutMs));
}

/** Decrypt the token of the provider a consumer references. Null when unset/missing. Needs the master key. */
export function resolveConsumerToken(
  store: ConsumerReader,
  consumer: CuratorConsumer,
): string | null {
  const providerId = store.getSetting(consumerKeys(consumer).provider) ?? "";
  if (!providerId) return null;
  return resolveProviderToken(store, providerId);
}

/**
 * One-shot migration of a pre-existing `curator.llm.*` install: synthesise a
 * `default` provider from the legacy endpoint/token and point both consumers at
 * it with the legacy model + timeout. Idempotent — a no-op once any provider
 * exists. Returns whether it migrated. Leaves the legacy keys in place (the
 * cutover that retires them is PR-B3, when the consumers actually switch).
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
    // never throw out of a tick.
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
  return true;
}
