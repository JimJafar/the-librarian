// Encryption-at-rest for the admin secret-store (memory-curator spec §7.1).
//
// The curator's LLM token (and any future admin secret) is stored encrypted,
// never in plaintext config or audit records. AES-256-GCM gives both
// confidentiality and integrity: the authentication tag means a tampered
// ciphertext or a wrong key fails to decrypt (rather than returning garbage).
//
// The master key comes from the operator (env `LIBRARIAN_SECRET_KEY`); it is
// injected into these functions, never read here, so the crypto stays pure and
// testable. A fresh random IV per encryption means encrypting the same value
// twice yields different ciphertexts.
//
// Server-only (node:crypto).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const VERSION = "gcm1"; // payload version tag, for future key/algorithm rotation

/**
 * Parse the operator-supplied master key into a 32-byte buffer. Accepts a
 * 64-char hex string or a base64-encoded 32-byte value. Throws if missing or
 * not exactly 32 bytes — callers treat that as "secrets unavailable" (curation
 * stays off) rather than proceeding with a weak/absent key.
 */
export function resolveSecretKey(raw: string | undefined): Buffer {
  const value = (raw ?? "").trim();
  if (value === "") {
    throw new Error("secret key is required (set LIBRARIAN_SECRET_KEY)");
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === KEY_BYTES) {
    return decoded;
  }
  throw new Error("secret key must be 32 bytes (a 64-char hex string or base64)");
}

/**
 * Encrypt a UTF-8 string. Returns a self-describing payload
 * `gcm1.<iv>.<tag>.<ciphertext>` (each segment base64; base64 never contains
 * `.`, so the segments are unambiguous).
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a payload produced by {@link encryptSecret}. Throws on a malformed
 * payload, a tampered ciphertext/tag, or a wrong key (GCM authentication
 * failure) — it never returns unauthenticated plaintext.
 */
export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  // ctB64 may legitimately be "" (empty plaintext), so guard for undefined.
  if (version !== VERSION || !ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error("malformed secret payload");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // `final()` throws if the auth tag doesn't verify (tamper or wrong key).
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
