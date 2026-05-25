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
import fs from "node:fs";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16; // 128-bit GCM authentication tag
// Payload version tag. Decryption dispatches on it, so a future format (e.g. a
// `gcm2` carrying a key-id for online rotation) can be added without breaking
// `gcm1` ciphertexts — rotation today means decrypt-all + re-encrypt under the
// new key. With a fresh random 96-bit IV per call, the same key is safe for far
// more than this store's handful of secrets (NIST SP 800-38D's ~2^32-message bound).
const VERSION = "gcm1";

/**
 * Parse the operator-supplied master key into a 32-byte buffer. Accepts a
 * 64-char hex string or a base64-encoded 32-byte value. Throws if missing,
 * not exactly 32 bytes, malformed, or a constant-byte placeholder — callers
 * treat that as "secrets unavailable" (curation stays off) rather than
 * proceeding with a weak/absent key. The key MUST come from a CSPRNG
 * (`openssl rand -hex 32` or `crypto.randomBytes(32)`).
 */
export function resolveSecretKey(raw: string | undefined): Buffer {
  const value = (raw ?? "").trim();
  if (value === "") {
    throw new Error("secret key is required (set LIBRARIAN_SECRET_KEY)");
  }

  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    // Base64 decoding is lenient (it silently drops invalid chars), so accept
    // it only if it round-trips exactly — rejecting truncated/garbled input
    // that would otherwise decode to a silently-different 32 bytes.
    const decoded = Buffer.from(value, "base64");
    const reEncoded = decoded.toString("base64");
    if (
      decoded.length === KEY_BYTES &&
      (value === reEncoded || value === reEncoded.replace(/=+$/, ""))
    ) {
      key = decoded;
    }
  }

  if (!key || key.length !== KEY_BYTES) {
    throw new Error("secret key must be 32 bytes (a 64-char hex string or base64)");
  }
  if (key.every((b) => b === key[0])) {
    throw new Error("secret key has insufficient entropy (constant-byte placeholder)");
  }
  return key;
}

/**
 * Resolve an OPTIONAL master key for store construction: returns null when the
 * env var is absent/blank (the store runs without secret support — plain admin
 * settings still work, secrets cannot be read/written), and a 32-byte key when
 * present. A present-but-malformed key still throws, so a typo'd key fails loudly
 * at boot rather than silently disabling secrets.
 */
export function resolveOptionalSecretKey(raw: string | undefined): Buffer | null {
  return (raw ?? "").trim() === "" ? null : resolveSecretKey(raw);
}

export interface LoadedSecretKey {
  key: Buffer;
  /** True when this call generated a fresh key (caller logs the one-time notice). */
  generated: boolean;
}

/**
 * The narrow slice of `node:fs` the credential-file helpers use. Injecting it
 * keeps the boot-credential resolver unit-testable without touching disk (a fake
 * models file presence + a writable/read-only volume); `node:fs` is the default.
 */
export interface FileIo {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string, options: { flag: string; mode: number }): void;
}

/**
 * Read the master key from `filePath`, or generate and persist one when the file
 * is absent (the D0 credential-bootstrap path: a fresh install gets a key on the
 * data volume with no operator action). The file is the durable home of the key
 * when `LIBRARIAN_SECRET_KEY` is unset.
 *
 * - Exists → read + validate via {@link resolveSecretKey} (throws on a malformed
 *   file rather than silently overwriting it — a bad key file is an operator
 *   signal, not garbage to clobber). Perms are left as-is (never widened).
 * - Absent → write a CSPRNG 32-byte key as 64-char hex with `open('wx', 0o600)`:
 *   `wx` fails if a racing boot already created it (closing the existsSync→write
 *   TOCTOU), and `0600` keeps it owner-only from creation.
 */
export function loadOrCreateSecretKeyFile(filePath: string, io: FileIo = fs): LoadedSecretKey {
  if (io.existsSync(filePath)) {
    return { key: resolveSecretKey(io.readFileSync(filePath, "utf8")), generated: false };
  }
  const keyHex = randomBytes(KEY_BYTES).toString("hex");
  io.writeFileSync(filePath, keyHex, { flag: "wx", mode: 0o600 });
  return { key: resolveSecretKey(keyHex), generated: true };
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
  // Strict boundary validation — the GCM tag check would reject these anyway,
  // but pinning the format gives a precise error and defends in depth.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("malformed secret payload");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // `final()` throws if the auth tag doesn't verify (tamper or wrong key).
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
