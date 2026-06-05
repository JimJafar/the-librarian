// Named LLM provider store (spec 042 §1). A provider is `{ id, name, endpoint,
// token }`; consumers (intake / grooming) reference a provider by its stable
// `id` and add their own `{ model, timeout_ms }`. The list is modelled on the
// flat single-string settings store rather than redesigning it:
//
//   llm.providers                = JSON array of provider ids   (non-secret)
//   llm.provider.<id>.name       = display label                (non-secret)
//   llm.provider.<id>.endpoint   = base URL                     (non-secret)
//   llm.provider.<id>.token      = bearer key                   (SECRET)
//
// Keeping the names/endpoints non-secret lets the dashboard list providers
// without the master key; only `resolveProviderToken` decrypts. The id is
// generated and stable, so renaming a provider never breaks a consumer's
// reference.
//
// The `llm.providers` index is updated read-modify-write; like every key in
// the settings store it is last-writer-wins on a single file (no locking).
// Provider CRUD is single-admin, low-frequency, so that matches the system's
// concurrency model rather than introducing a new risk.

import { z } from "zod";
import { makeId } from "./constants.js";
import type { LlmConnectionReader, LlmConnectionWriter } from "./llm-connection.js";

export interface LlmProvider {
  id: string;
  name: string;
  endpoint: string;
  /** Whether a bearer token is stored — never the value. */
  hasToken: boolean;
}

export interface LlmProviderInput {
  name: string;
  endpoint: string;
  /** Plaintext bearer key; stored encrypted. Omitted/empty = no token. */
  token?: string;
}

export interface LlmProviderPatch {
  name?: string;
  endpoint?: string;
  /** Plaintext token; stored encrypted. Empty string clears it. */
  token?: string;
}

// Zod input shapes for admin validation at the tRPC boundary. Permissive
// (presence-only); the non-empty invariants are enforced in add/updateProvider,
// the single source of truth.
export const LlmProviderInputSchema = z.strictObject({
  name: z.string(),
  endpoint: z.string(),
  token: z.string().optional(),
});

export const LlmProviderPatchSchema = z.strictObject({
  name: z.string().optional(),
  endpoint: z.string().optional(),
  token: z.string().optional(),
});

const INDEX_KEY = "llm.providers";

type ProviderReader = LlmConnectionReader;
type ProviderStore = LlmConnectionReader & LlmConnectionWriter;

interface ProviderKeys {
  name: string;
  endpoint: string;
  token: string;
}

function providerKeys(id: string): ProviderKeys {
  const prefix = `llm.provider.${id}`;
  return { name: `${prefix}.name`, endpoint: `${prefix}.endpoint`, token: `${prefix}.token` };
}

/** Parse the provider-id index. Fail-soft: a missing or malformed value is []. */
export function listProviderIds(store: ProviderReader): string[] {
  const raw = store.getSetting(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function writeProviderIds(store: ProviderStore, ids: string[]): void {
  store.setSetting(INDEX_KEY, JSON.stringify(ids));
}

function tokenPresent(store: ProviderReader, keys: ProviderKeys): boolean {
  return store.listSettings().some((m) => m.key === keys.token);
}

/** Read one provider, or null when the id is not in the index. */
export function getProvider(store: ProviderReader, id: string): LlmProvider | null {
  if (!listProviderIds(store).includes(id)) return null;
  const keys = providerKeys(id);
  return {
    id,
    name: store.getSetting(keys.name) ?? "",
    endpoint: store.getSetting(keys.endpoint) ?? "",
    hasToken: tokenPresent(store, keys),
  };
}

/** Every provider, in index (insertion) order. Never includes token values. */
export function listProviders(store: ProviderReader): LlmProvider[] {
  return listProviderIds(store)
    .map((id) => getProvider(store, id))
    .filter((p): p is LlmProvider => p !== null);
}

/**
 * Create a provider. `name` + `endpoint` are required (teaching error
 * otherwise). The token is stored encrypted; omit it to add a provider whose
 * key is set later. Returns the created provider (presence-only).
 */
export function addProvider(
  store: ProviderStore,
  input: LlmProviderInput,
  options: { generateId?: () => string } = {},
): LlmProvider {
  const name = input.name.trim();
  const endpoint = input.endpoint.trim();
  if (!name) throw new Error("provider name must not be empty");
  if (!endpoint) throw new Error("provider endpoint must not be empty");

  const id = (options.generateId ?? (() => makeId("prov")))();
  // The id becomes part of every per-provider settings key
  // (`llm.provider.<id>.token`); keep it key-safe so one provider's namespace
  // can never collide with another's. The default `makeId` already satisfies this.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`provider id must match /^[A-Za-z0-9_-]+$/ (got "${id}")`);
  }
  const keys = providerKeys(id);
  store.setSetting(keys.name, name);
  store.setSetting(keys.endpoint, endpoint);
  if (input.token !== undefined && input.token !== "") {
    store.setSetting(keys.token, input.token, { secret: true });
  }
  writeProviderIds(store, [...listProviderIds(store), id]);
  // Non-null: we just wrote the index entry + keys.
  return getProvider(store, id) as LlmProvider;
}

/** Patch a provider's name/endpoint/token without changing its id. */
export function updateProvider(store: ProviderStore, id: string, patch: LlmProviderPatch): void {
  if (!listProviderIds(store).includes(id)) {
    throw new Error(`unknown provider id: ${id}`);
  }
  const keys = providerKeys(id);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("provider name must not be empty");
    store.setSetting(keys.name, name);
  }
  if (patch.endpoint !== undefined) {
    const endpoint = patch.endpoint.trim();
    if (!endpoint) throw new Error("provider endpoint must not be empty");
    store.setSetting(keys.endpoint, endpoint);
  }
  if (patch.token !== undefined) {
    if (patch.token === "") store.deleteSetting(keys.token);
    else store.setSetting(keys.token, patch.token, { secret: true });
  }
}

/** Remove a provider, its keys, and its index entry. Idempotent. */
export function deleteProvider(store: ProviderStore, id: string): void {
  const ids = listProviderIds(store);
  if (!ids.includes(id)) return;
  const keys = providerKeys(id);
  store.deleteSetting(keys.name);
  store.deleteSetting(keys.endpoint);
  store.deleteSetting(keys.token);
  writeProviderIds(
    store,
    ids.filter((x) => x !== id),
  );
}

/** Decrypt a provider's bearer token. Null when the provider/token is absent. Needs the master key. */
export function resolveProviderToken(store: ProviderReader, id: string): string | null {
  if (!listProviderIds(store).includes(id)) return null;
  return store.getSetting(providerKeys(id).token);
}
