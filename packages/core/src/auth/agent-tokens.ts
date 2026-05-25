// DB-stored agent tokens (spec: single-owner-auth, A3).
//
// The owner mints agent tokens from the dashboard instead of hand-editing the
// LIBRARIAN_AGENT_TOKENS env var. Tokens are high-entropy random values, so we
// store a salted SHA-256 HASH (not reversible encryption) — even a settings dump
// can't recover a token. The plaintext is returned exactly ONCE, at creation.
//
// Token shape: `lib.<id>.<secret>` (the id locates the record in O(1); base64url
// never contains `.`, so the split is unambiguous). Verification recomputes the
// hash for that id and compares timing-safe. Stored in the existing `settings`
// table (key `agent_token:<id>`, plain — the value is already a hash), so there is
// NO schema bump and verification works without LIBRARIAN_SECRET_KEY.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "agent_token:";
const TOKEN_PREFIX = "lib";

type SettingsLike = {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  deleteSetting?: (key: string) => void;
  listSettings: () => { key: string }[];
};

interface TokenRecord {
  id: string;
  agentId: string;
  label: string;
  salt: string;
  hash: string;
  created_at: string;
}

export interface AgentTokenMeta {
  id: string;
  agentId: string;
  label: string;
  created_at: string;
}

export interface CreatedAgentToken {
  id: string;
  token: string;
}

function hashSecret(salt: string, secret: string): string {
  return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

export function createAgentToken(
  store: SettingsLike,
  input: { agentId: string; label?: string },
): CreatedAgentToken {
  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const record: TokenRecord = {
    id,
    agentId: input.agentId,
    label: input.label ?? "",
    salt,
    hash: hashSecret(salt, secret),
    created_at: new Date().toISOString(),
  };
  store.setSetting(KEY_PREFIX + id, JSON.stringify(record));
  return { id, token: `${TOKEN_PREFIX}.${id}.${secret}` };
}

export function listAgentTokens(store: SettingsLike): AgentTokenMeta[] {
  const metas: AgentTokenMeta[] = [];
  for (const { key } of store.listSettings()) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const raw = store.getSetting(key);
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as TokenRecord;
      metas.push({ id: r.id, agentId: r.agentId, label: r.label, created_at: r.created_at });
    } catch {
      // skip a malformed record rather than failing the whole list
    }
  }
  return metas.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function revokeAgentToken(store: SettingsLike, id: string): boolean {
  if (!store.getSetting(KEY_PREFIX + id)) return false;
  store.deleteSetting?.(KEY_PREFIX + id);
  return true;
}

export function verifyAgentToken(
  store: SettingsLike,
  presented: string,
): { agentId: string } | null {
  const parts = presented.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, id, secret] = parts;
  const raw = store.getSetting(KEY_PREFIX + id);
  if (!raw) return null;
  let record: TokenRecord;
  try {
    record = JSON.parse(raw) as TokenRecord;
  } catch {
    return null;
  }
  const candidate = Buffer.from(hashSecret(record.salt, secret ?? ""), "hex");
  const stored = Buffer.from(record.hash, "hex");
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return null;
  return { agentId: record.agentId };
}
