// Owner password auth (dashboard-managed-auth, D1).
//
// One owner, one password. The password is hashed with scrypt (node:crypto, no
// native dep) and stored as a *plain* setting — a hash is already non-reversible,
// like agent tokens, so verification works without LIBRARIAN_SECRET_KEY. The cost
// params live IN the record, so they can be tuned later without invalidating old
// hashes. The username is operator-chosen and stored alongside.
//
// Pure over a SettingsLike, so the logic is testable without HTTP or a real DB.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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

// ----- Lockout (D1.2) -----
//
// Brute-force defense for the single owner. Failures accumulate within a window;
// the threshold trips an exponentially-growing lock. State lives in a plain
// setting, so it survives restarts and is authoritative store-side. `now` is
// injectable for deterministic tests.

export const LOCKOUT_KEY = "auth:lockout";
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000; // failures older than this (while unlocked) start a fresh window
const BASE_LOCK_MS = 60_000; // lock at the threshold; doubles per breach beyond it
const MAX_LOCK_MS = 60 * 60_000; // cap

interface LockoutRecord {
  failures: number;
  firstFailureAt: string;
  lockedUntil: string | null;
}

export interface LockoutState {
  locked: boolean;
  lockedUntil: string | null;
  failures: number;
}

export interface OwnerAuthResult {
  ok: boolean;
  locked: boolean;
  lockedUntil: string | null;
}

function readLockout(store: SettingsLike): LockoutRecord | null {
  const raw = store.getSetting(LOCKOUT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LockoutRecord;
  } catch {
    return null;
  }
}

function isLocked(rec: LockoutRecord | null, now: Date): boolean {
  return rec?.lockedUntil != null && now.getTime() < Date.parse(rec.lockedUntil);
}

export function getLockoutState(store: SettingsLike, now: Date = new Date()): LockoutState {
  const rec = readLockout(store);
  return {
    locked: isLocked(rec, now),
    lockedUntil: rec?.lockedUntil ?? null,
    failures: rec?.failures ?? 0,
  };
}

/** Clear the lockout state (on success, or via the CLI break-glass). */
export function resetLockout(store: SettingsLike): void {
  store.deleteSetting?.(LOCKOUT_KEY);
}

function recordFailure(store: SettingsLike, now: Date): LockoutRecord {
  const existing = readLockout(store);
  let failures = 1;
  let firstFailureAt = now.toISOString();
  if (existing) {
    const withinWindow = now.getTime() - Date.parse(existing.firstFailureAt) <= FAILURE_WINDOW_MS;
    // Keep counting if still inside the window or still serving a lock; otherwise the
    // streak has aged out and a new window starts at this failure.
    if (withinWindow || isLocked(existing, now)) {
      failures = existing.failures + 1;
      firstFailureAt = existing.firstFailureAt;
    }
  }
  let lockedUntil: string | null = null;
  if (failures >= MAX_FAILURES) {
    const duration = Math.min(BASE_LOCK_MS * 2 ** (failures - MAX_FAILURES), MAX_LOCK_MS);
    lockedUntil = new Date(now.getTime() + duration).toISOString();
  }
  const rec: LockoutRecord = { failures, firstFailureAt, lockedUntil };
  store.setSetting(LOCKOUT_KEY, JSON.stringify(rec));
  return rec;
}

/**
 * Lockout-aware owner login — the entry point the dashboard/tRPC verify path calls.
 * A live lock short-circuits before any password check (so a correct password can't
 * bypass it); a success clears the lockout; a miss records a failure that may trip
 * the lock. The pure {@link verifyOwnerPassword} stays side-effect-free for callers
 * that just need a compare.
 */
export function authenticateOwner(
  store: SettingsLike,
  username: string,
  password: string,
  now: Date = new Date(),
): OwnerAuthResult {
  const state = getLockoutState(store, now);
  if (state.locked) {
    return { ok: false, locked: true, lockedUntil: state.lockedUntil };
  }
  if (verifyOwnerPassword(store, username, password)) {
    resetLockout(store);
    return { ok: true, locked: false, lockedUntil: null };
  }
  const rec = recordFailure(store, now);
  return { ok: false, locked: isLocked(rec, now), lockedUntil: rec.lockedUntil };
}

// ----- One-time setup links (D1.3) -----
//
// A short-TTL, single-use link the owner opens in the browser to set a password
// (the CLI mints it so the plaintext stays out of shell history). Mirrors the
// agent-token shape: the secret is hashed (salted SHA-256 — already non-reversible),
// the id locates the record in O(1), and the plaintext is returned exactly once.

const SETUP_LINK_PREFIX = "auth:setup_link:";
const SETUP_TOKEN_PREFIX = "libsetup";

interface SetupLinkRecord {
  id: string;
  salt: string;
  hash: string;
  expiresAt: string;
  usedAt: string | null;
  created_at: string;
}

function hashSetupSecret(salt: string, secret: string): string {
  return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

/** Mint a one-time setup link; returns the plaintext token `libsetup.<id>.<secret>` once. */
export function mintSetupLink(store: SettingsLike, ttlMs: number, now: Date = new Date()): string {
  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const record: SetupLinkRecord = {
    id,
    salt,
    hash: hashSetupSecret(salt, secret),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    usedAt: null,
    created_at: now.toISOString(),
  };
  store.setSetting(SETUP_LINK_PREFIX + id, JSON.stringify(record));
  return `${SETUP_TOKEN_PREFIX}.${id}.${secret}`;
}

/**
 * Validate and consume a setup link in one step: rejects an unknown, expired,
 * already-used, or hash-mismatched token; on success marks it used (so a replay
 * fails) and returns true. The id is public (it travels in the token); the secret
 * is gated by the timing-safe hash compare.
 */
export function consumeSetupLink(
  store: SettingsLike,
  token: string,
  now: Date = new Date(),
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SETUP_TOKEN_PREFIX) return false;
  const [, id, secret] = parts;
  const raw = store.getSetting(SETUP_LINK_PREFIX + id);
  if (!raw) return false;
  let rec: SetupLinkRecord;
  try {
    rec = JSON.parse(raw) as SetupLinkRecord;
  } catch {
    return false;
  }
  if (rec.usedAt) return false; // single-use
  if (now.getTime() > Date.parse(rec.expiresAt)) return false; // expired
  const candidate = Buffer.from(hashSetupSecret(rec.salt, secret ?? ""), "hex");
  const stored = Buffer.from(rec.hash, "hex");
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return false;
  rec.usedAt = now.toISOString();
  store.setSetting(SETUP_LINK_PREFIX + id, JSON.stringify(rec));
  return true;
}
