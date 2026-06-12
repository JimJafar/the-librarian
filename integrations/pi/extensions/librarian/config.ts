// Environment-driven configuration for the Pi ↔ Librarian integration.
//
// The extension stays DORMANT unless a remote Librarian is configured
// (LIBRARIAN_MCP_URL + LIBRARIAN_AGENT_TOKEN). This mirrors the other harness
// integrations: no endpoint/token → no automatic calls, no surprises.
//
// 2026-06-12 rethink (spec §7, D14) — the session-era `projectKey` /
// `deviceId` fields are retired with the session subsystem; the surviving
// config is exactly what the 7 tool proxies + primer fetch need.

export const HARNESS = "pi" as const;

export interface LibrarianConfig {
  endpoint: string;
  token: string;
  timeoutMs?: number | undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read config from the environment. Returns null when the remote Librarian is
 * not configured — the caller treats that as "extension dormant".
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): LibrarianConfig | null {
  const endpoint = env.LIBRARIAN_MCP_URL?.trim();
  const token = env.LIBRARIAN_AGENT_TOKEN?.trim();
  if (!endpoint || !token) return null;

  const config: LibrarianConfig = { endpoint, token };
  const timeoutMs = parsePositiveInt(env.LIBRARIAN_TIMEOUT_MS);
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  return config;
}
