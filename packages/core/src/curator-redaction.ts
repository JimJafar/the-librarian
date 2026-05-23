// Secret redaction for curator evidence (memory-curator spec §9).
//
// Evidence gathered for a curation run (memory bodies, session summaries,
// commands run, file paths, metadata) is scrubbed of secret-looking material
// BEFORE prompt construction — the spec is emphatic that catching secrets at
// output-validation time is too late, since the value would already have been
// sent to the LLM.
//
// This is a conservative, KNOWN-FORMAT redactor: PEM private keys, well-known
// provider token shapes, JWTs, and `key = secret` assignments. It deliberately
// does NOT do generic high-entropy detection — that would nuke legitimate
// content (git SHAs, UUIDs, content hashes) and degrade the curator's evidence.
// Entropy/semantic detection is a v2 concern. Better to miss an exotic custom
// secret than to shred every long identifier; the high-signal patterns below
// cover the overwhelming majority of real leaks.
//
// Server-only; no external dependencies (pure string transforms).

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

// Order matters: the assignment rule runs first so an assigned secret is
// redacted as a single unit; the marker it leaves (`[REDACTED:secret]`) is not
// matched by any later rule, avoiding double-counting. The provider/JWT/PEM
// rules then catch bare (un-assigned) secrets.
const RULES: readonly RedactionRule[] = [
  {
    // `api_key = …`, `PASSWORD: …`, `MY_SECRET_KEY="…"`. $1 keeps the key +
    // separator for context; only the value (6+ non-space, non-quote chars)
    // is redacted. The keyword must sit immediately before the separator, so
    // "secretary: Smith" is not mistaken for a secret.
    name: "secret-assignment",
    pattern:
      /\b([\w-]*(?:passwords?|passwd|api[_-]?keys?|access[_-]?keys?|secret[_-]?keys?|client[_-]?secrets?|auth[_-]?tokens?|secrets?|tokens?))(\s*[:=]\s*["']?)([^\s"']{6,})/gi,
    replacement: "$1$2[REDACTED:secret]",
  },
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws-key]",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}\b/g,
    replacement: "[REDACTED:google-key]",
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
    replacement: "[REDACTED:slack-token]",
  },
  {
    // OpenAI / Anthropic style: `sk-…` and `sk-ant-…`.
    name: "api-key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED:api-key]",
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
    replacement: "Bearer [REDACTED:bearer]",
  },
];

export interface RedactionResult {
  /** The input with secret-looking material replaced by `[REDACTED:…]` markers. */
  redacted: string;
  /** How many secrets were redacted (sum across all rules). */
  count: number;
}

/**
 * Redact secret-looking material from a single string. Pure and idempotent-ish:
 * re-running over already-redacted text finds nothing new (markers aren't
 * matched by any rule).
 */
export function redactSecrets(text: string): RedactionResult {
  let redacted = text;
  let count = 0;
  for (const rule of RULES) {
    const matches = redacted.match(rule.pattern);
    if (matches && matches.length > 0) {
      count += matches.length;
      redacted = redacted.replace(rule.pattern, rule.replacement);
    }
  }
  return { redacted, count };
}
