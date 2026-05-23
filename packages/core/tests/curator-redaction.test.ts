// Secret redaction for curator evidence (memory-curator spec §9).
//
// Evidence (memory bodies, session summaries, commands run, file paths,
// metadata) must have secret-looking material redacted BEFORE prompt
// construction — "do not wait until output validation to catch secrets; by
// then the sensitive value may already have been sent to an LLM." This is the
// conservative known-format + assignment redactor behind that boundary.

import { redactSecrets } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("redactSecrets", () => {
  it("leaves clean text untouched and reports zero redactions", () => {
    const { redacted, count } = redactSecrets("A normal memory about the deploy process.");
    expect(redacted).toBe("A normal memory about the deploy process.");
    expect(count).toBe(0);
  });

  it("redacts a PEM private key block", () => {
    const input =
      "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\ndone";
    const { redacted, count } = redactSecrets(input);
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).toContain("done");
  });

  it("redacts common provider token formats", () => {
    const cases = [
      "sk-abcdef012345678901234567890123456789",
      "sk-ant-api03-ABCdef0123456789ABCdef0123456789",
      "ghp_ABCDEFabcdef0123456789ABCDEFabcdef0123",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-ABCDEFabcdef",
      "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
    ];
    for (const secret of cases) {
      const { redacted, count } = redactSecrets(`token is ${secret} ok`);
      expect(redacted, secret).not.toContain(secret);
      expect(count, secret).toBeGreaterThanOrEqual(1);
    }
  });

  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const { redacted } = redactSecrets(`auth: ${jwt}`);
    expect(redacted).not.toContain(jwt);
  });

  it("redacts a Bearer token but keeps the surrounding label", () => {
    const { redacted } = redactSecrets("Authorization: Bearer sk-secrettokenvalue1234567890abcd");
    expect(redacted).toContain("Authorization:");
    expect(redacted).not.toContain("sk-secrettokenvalue1234567890abcd");
  });

  it("redacts the value of a secret-like assignment, keeping the key for context", () => {
    const { redacted } = redactSecrets("API_KEY=supersecretvalue123  PASSWORD: hunter2hunter2");
    expect(redacted).toContain("API_KEY");
    expect(redacted).not.toContain("supersecretvalue123");
    expect(redacted).not.toContain("hunter2hunter2");
  });

  it("does not redact ordinary high-length identifiers (git SHA, UUID)", () => {
    // Entropy-based detection is deferred (v2) precisely to avoid nuking these.
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const { redacted, count } = redactSecrets(`commit ${sha} for ${uuid}`);
    expect(redacted).toContain(sha);
    expect(redacted).toContain(uuid);
    expect(count).toBe(0);
  });

  it("counts multiple redactions", () => {
    const { count } = redactSecrets(
      "ghp_ABCDEFabcdef0123456789ABCDEFabcdef0123 and AKIAIOSFODNN7EXAMPLE",
    );
    expect(count).toBe(2);
  });
});
