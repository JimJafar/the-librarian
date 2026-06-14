// Secret redaction for captured docker/git output before it reaches a
// user-facing error or log (C1 / I-3 / S-2).
//
// `up`, `update`, and `admin` all surface a failed step's stderr/stdout so the
// operator can triage — but those streams can carry secrets: the server's
// one-time admin-token generation notice emits the token BY VALUE
// (`packages/mcp-server/src/bin/http.ts`), a `docker run -e
// LIBRARIAN_AGENT_TOKEN=…`/`restore --secret-key …` failure can echo the argv,
// and a master key is a raw 64-hex run. This single helper is the shared choke
// point so every surface redacts identically (no surface forgets).
//
// We defend three ways:
//   - drop any whole line carrying the admin-token generation notice;
//   - redact any `libadmin_<base64url>` token substring (the bearer shape);
//   - redact any standalone 64-hex run (a raw key/token shape: the master key
//     and the CSPRNG agent token are both 64-hex).
// The redacted remainder is still surfaced so debugging works — just no secrets.
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/Generated a new admin token/i.test(line))
    .join("\n")
    .replace(/libadmin_[A-Za-z0-9_-]+/g, "[redacted-admin-token]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[redacted]");
}
