// Encryption-at-rest primitive for the admin secret-store (memory-curator §7.1:
// the LLM token is stored via admin secret-storage, never in plaintext).
//
// AES-256-GCM: confidentiality + integrity (the auth tag detects tampering and
// wrong keys). Pins round-trip, IV uniqueness, tamper/wrong-key rejection, and
// key parsing.

import { decryptSecret, encryptSecret, resolveSecretKey } from "@librarian/core";
import { describe, expect, it } from "vitest";

// A fixed 32-byte test key (hex).
const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const key = resolveSecretKey(KEY_HEX);

describe("encryptSecret / decryptSecret (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const plaintext = "sk-test-the-actual-llm-token-value";
    const payload = encryptSecret(plaintext, key);
    expect(payload).not.toContain(plaintext); // ciphertext, not the value
    expect(decryptSecret(payload, key)).toBe(plaintext);
  });

  it("round-trips unicode and empty strings", () => {
    for (const value of ["", "café — 秘密 — 🔒", "a".repeat(5000)]) {
      expect(decryptSecret(encryptSecret(value, key), key)).toBe(value);
    }
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe("same");
    expect(decryptSecret(b, key)).toBe("same");
  });

  it("rejects a tampered ciphertext (auth tag)", () => {
    const payload = encryptSecret("secret", key);
    // Flip the last base64 char of the ciphertext segment.
    const tampered = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("fails to decrypt with the wrong key", () => {
    const payload = encryptSecret("secret", key);
    const otherKey = resolveSecretKey(
      "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    );
    expect(() => decryptSecret(payload, otherKey)).toThrow();
  });
});

describe("resolveSecretKey", () => {
  it("accepts a 64-char hex key", () => {
    expect(resolveSecretKey(KEY_HEX)).toHaveLength(32);
  });

  it("accepts a 32-byte base64 key", () => {
    const b64 = Buffer.alloc(32, 7).toString("base64");
    expect(resolveSecretKey(b64)).toHaveLength(32);
  });

  it("rejects a missing key", () => {
    expect(() => resolveSecretKey(undefined)).toThrow(/key/i);
    expect(() => resolveSecretKey("")).toThrow(/key/i);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => resolveSecretKey("tooshort")).toThrow(/32 bytes/i);
    expect(() => resolveSecretKey("aa".repeat(20))).toThrow(/32 bytes/i); // 20 bytes hex
  });
});
