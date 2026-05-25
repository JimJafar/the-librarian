// Owner password auth (dashboard-managed-auth, D1).
//
// One owner, one password. The password is hashed with scrypt (node:crypto, no
// native dep) and stored as a *plain* setting — a hash is already non-reversible,
// like agent tokens, so verification works without LIBRARIAN_SECRET_KEY. The cost
// params live IN the record, so they can be tuned later without invalidating old
// hashes. The username is operator-chosen and stored alongside.
//
// Pure over a SettingsLike, so the logic is testable without HTTP or a real DB.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const PASSWORD_KEY = "auth:password";

// Tuned scrypt cost: N=16384 (~16 MB), r=8, p=1 → ~50-100ms on reference hardware,
// the proportionate control for a single self-hosted owner.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;
// A length floor only — no rotation/complexity theatre for a single owner; length
// is the control that actually matters against guessing, paired with lockout (D1.2).
const MIN_PASSWORD_LENGTH = 12;

export type SettingsLike = {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  deleteSetting?: (key: string) => void;
  listSettings: () => { key: string }[];
};

interface PasswordRecord {
  username: string;
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
  keylen: number;
  updated_at: string;
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

export function setOwnerPassword(store: SettingsLike, username: string, password: string): void {
  const user = username.trim();
  if (!user) throw new Error("username is required");
  assertPasswordPolicy(password);
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN, SCRYPT_PARAMS).toString("hex");
  const record: PasswordRecord = {
    username: user,
    salt,
    hash,
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    keylen: KEYLEN,
    updated_at: new Date().toISOString(),
  };
  store.setSetting(PASSWORD_KEY, JSON.stringify(record)); // plain: the value is a one-way hash
}

/** Read the stored password record, or null when none/parse failure. */
function readPasswordRecord(store: SettingsLike): PasswordRecord | null {
  const raw = store.getSetting(PASSWORD_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PasswordRecord;
  } catch {
    return null;
  }
}

/**
 * Timing-safe password check. The username compare is an early return (the owner
 * username is effectively public for a single-owner deployment); the password
 * compare runs in constant time against the stored hash. Hashing uses the params
 * recorded at set time, so a future cost bump leaves old hashes verifiable.
 */
export function verifyOwnerPassword(
  store: SettingsLike,
  username: string,
  password: string,
): boolean {
  const rec = readPasswordRecord(store);
  if (!rec) return false;
  if (rec.username !== username) return false;
  const candidate = scryptSync(password, rec.salt, rec.keylen, { N: rec.N, r: rec.r, p: rec.p });
  const stored = Buffer.from(rec.hash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/** Whether an owner password has been configured. */
export function hasOwnerPassword(store: SettingsLike): boolean {
  return readPasswordRecord(store) !== null;
}

/** The configured owner username, or null when no password is set. */
export function ownerPasswordUsername(store: SettingsLike): string | null {
  return readPasswordRecord(store)?.username ?? null;
}
