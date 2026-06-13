// Config core: MCP URL, agent token, and derived server URL.
//
// The persisted truth is `~/.librarian/env` (token + MCP URL). The
// server URL is *derived* by default — it's the origin of the MCP URL —
// but can be set explicitly. Reading config never exposes the token: the
// redacted view reports only whether it's *set*, never the value.
//
// `home` is injectable everywhere so tests run against a temp dir.

import { detectShell, readEnvFile, writeEnvFile, type Shell } from "./env.js";
import { applyShellBlock } from "./env.js";

export interface LibrarianConfig {
  /** The MCP endpoint URL the harnesses talk to. */
  mcpUrl: string;
  /** The bearer token. NEVER printed; redacted on display. */
  token: string;
  /** The server base URL; defaults to the MCP URL's origin. */
  serverUrl: string;
}

/** A display-safe view of the config — token is redacted to a boolean. */
export interface RedactedConfig {
  mcpUrl: string;
  /** True iff a non-empty token is set. The value itself is never exposed. */
  tokenSet: boolean;
  serverUrl: string;
}

/** Derive the server base URL (origin) from the MCP URL; "" if unparseable. */
export function deriveServerUrl(mcpUrl: string): string {
  if (!mcpUrl) return "";
  try {
    return new URL(mcpUrl).origin;
  } catch {
    return "";
  }
}

/** Load the current config from `~/.librarian/env`, or null if unset. */
export function readConfig(home?: string): LibrarianConfig | null {
  const env = readEnvFile(home);
  if (!env) return null;
  return {
    mcpUrl: env.mcpUrl,
    token: env.token,
    serverUrl: deriveServerUrl(env.mcpUrl),
  };
}

/** A display-safe view: the token is reduced to a boolean, never printed. */
export function redact(config: LibrarianConfig): RedactedConfig {
  return {
    mcpUrl: config.mcpUrl,
    tokenSet: config.token.length > 0,
    serverUrl: config.serverUrl,
  };
}

/** Render the redacted config as human-readable lines (no token value). */
export function formatConfig(config: RedactedConfig): string {
  return [
    `MCP URL:    ${config.mcpUrl || "(not set)"}`,
    `Server URL: ${config.serverUrl || "(not set)"}`,
    `Token:      ${config.tokenSet ? "set (hidden)" : "(not set)"}`,
  ].join("\n");
}

export interface SetConfigInput {
  mcpUrl?: string | undefined;
  token?: string | undefined;
}

/**
 * Update config values and persist them to `~/.librarian/env`.
 *
 * Merges over whatever is already stored (so setting just the token
 * keeps the URL). Re-applies the managed shell block so a fresh `config`
 * on a new shell still wires up sourcing. Returns the new config.
 */
export function setConfig(
  input: SetConfigInput,
  options: { home?: string | undefined; shell?: Shell | undefined } = {},
): LibrarianConfig {
  const current = readEnvFile(options.home);
  const mcpUrl = input.mcpUrl ?? current?.mcpUrl ?? "";
  const token = input.token ?? current?.token ?? "";
  writeEnvFile({ mcpUrl, token }, options.home);
  const shell = options.shell ?? detectShell();
  applyShellBlock(shell, { mcpUrl, token }, options.home);
  return { mcpUrl, token, serverUrl: deriveServerUrl(mcpUrl) };
}
