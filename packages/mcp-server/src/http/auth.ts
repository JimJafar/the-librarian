// HTTP auth + origin gating for the MCP server.
//
// Pure functions over a `AuthConfig` record. Boot-time validation lives
// in `bin/http.ts`; this module only resolves requests against an
// already-validated config so it stays unit-testable.

import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Which listener a request arrives on (ADR 0008 P1/P3). Mirrors routes.ts. */
export type AuthSurface = "public" | "internal";

export interface AuthConfig {
  /**
   * The dashboard auth-enable land-grab token (ADR 0008 P3): NO LONGER a network
   * gate — it never grants a role in {@link authenticateMcp}. It only seeds the
   * tRPC context's `adminToken` for the `auth.enable` timing-safe compare (the
   * operator types it once to flip enforcement on). Optional; "" when unset.
   */
  adminToken: string;
  agentToken: string;
  agentTokenMap: Map<string, string>;
  allowedOrigins: string[];
  /**
   * The no-auth bypass. When true, a public /mcp request with no/invalid bearer
   * resolves to `agent` — NEVER admin (ADR 0008 P3). Resolved at boot by
   * {@link resolveAllowNoAuth}, which fires the bypass ONLY when auth isn't
   * genuinely in force: the explicit LIBRARIAN_ALLOW_NO_AUTH=true opt-out, or a
   * loopback bind with NO agent token configured. A configured agent token is
   * therefore enforced even on loopback — closing the regression where a loopback
   * bind silently disabled a configured-token gate.
   */
  allowNoAuth: boolean;
  host: string;
  port: number;
  /**
   * Optional DB-backed token verifier (dashboard-minted agent tokens). Checked
   * AFTER the env tokens (backward compatible). Returns the agent id on a match,
   * else null. Always resolves to the `agent` role — DB tokens can't be admin.
   */
  verifyDbToken?: (token: string) => { agentId?: string } | null;
}

export interface AuthResult {
  role: "admin" | "agent";
  agentId?: string;
}

/**
 * Resolve a request's role PER SURFACE (ADR 0008 P3 — the security core).
 *
 * The admin token is no longer a network gate: the surface is. So the role
 * decision branches on which listener served the request:
 *
 *   - "internal" (/trpc): the internal listener is trusted — it's loopback /
 *     internal-docker-network only and never published — so it grants `admin`
 *     with NO bearer. The socket itself is the boundary.
 *   - "public" (/mcp): AGENT-ROLE ONLY. There is deliberately NO branch that
 *     resolves to admin here, so a network peer can never reach an admin action
 *     on the published port — even with no admin token configured. A valid agent
 *     token (env, map, or DB-minted) → agent; the localhost bypass → agent;
 *     anything else → null (401).
 */
export function authenticateMcp(
  req: IncomingMessage,
  config: AuthConfig,
  surface: AuthSurface = "public",
): AuthResult | null {
  // The internal listener is trusted by virtue of not being on the network.
  if (surface === "internal") return { role: "admin" };

  // Public /mcp: agent-role only. Try the configured agent credentials first so a
  // real token is attributed to its agent even under the localhost bypass.
  const agent = resolveAgent(req, config);
  if (agent) return agent;

  // localhost / ALLOW_NO_AUTH bypass: grant AGENT (never admin) so a tokenless
  // local dev call still works without opening an admin path on this surface.
  if (config.allowNoAuth) return { role: "agent" };

  return null;
}

/** Match a bearer against the agent credentials (env tokens, map, DB). Never admin. */
function resolveAgent(req: IncomingMessage, config: AuthConfig): AuthResult | null {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  for (const [agentId, mappedToken] of config.agentTokenMap) {
    if (timingSafeEqual(token, mappedToken)) return { role: "agent", agentId };
  }
  if (config.agentToken && timingSafeEqual(token, config.agentToken)) return { role: "agent" };
  // DB-minted agent tokens, last and always agent-role (never admin). A null from
  // the verifier is indistinguishable from any other miss → one generic failure.
  // The agentId-less branch only exists because AuthConfig permits an agentId-less
  // match; the real injected verifier (verifyAgentToken) always carries an agentId.
  if (config.verifyDbToken) {
    const db = config.verifyDbToken(token);
    if (db) return db.agentId ? { role: "agent", agentId: db.agentId } : { role: "agent" };
  }
  return null;
}

/**
 * Is loopback the bind host? Loopback is the one host where a no-auth bypass is
 * defensible (the socket is unreachable from the network).
 */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost";
}

/**
 * The boot-time no-auth decision (ADR 0008 P3 regression fix). The localhost
 * bypass must fire ONLY when auth isn't genuinely in force — otherwise a loopback
 * bind silently disables a configured agent-token gate (the bug: a configured
 * token grants `agent` on a tokenless /mcp via the bypass). So the bypass is:
 *
 *   - the EXPLICIT opt-out: LIBRARIAN_ALLOW_NO_AUTH === "true" (the all-in-one
 *     localhost path opts into no-auth even WITH a token set — that's deliberate); OR
 *   - the IMPLICIT zero-config local-dev case: a loopback bind AND no agent auth
 *     configured (no LIBRARIAN_AGENT_TOKEN, no LIBRARIAN_AGENT_TOKENS).
 *
 * A configured agent token (single or per-agent map) is therefore ENFORCED on
 * loopback too — only an exposed bind with NO token still 401s (never silently
 * opens). DB-minted tokens don't keep the bypass off: the verifier is always
 * wired in production, and a minted token authenticates on its own, so it has no
 * bearing on the zero-config-dev bypass.
 */
export function resolveAllowNoAuth(opts: {
  allowNoAuthEnv?: string | undefined;
  host: string;
  agentToken: string;
  agentTokenMap: Map<string, string>;
}): boolean {
  if (opts.allowNoAuthEnv === "true") return true;
  const noAgentAuthConfigured = !opts.agentToken && opts.agentTokenMap.size === 0;
  return isLoopbackHost(opts.host) && noAgentAuthConfigured;
}

export function isAllowedOrigin(req: IncomingMessage, config: AuthConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
  try {
    const originUrl = new URL(origin);
    const hostHeader = req.headers.host || `${config.host}:${config.port}`;
    return originUrl.origin === `http://${hostHeader}`;
  } catch {
    return false;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return cryptoTimingSafeEqual(left, right);
}

export function parseCsv(value: string): string[] {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export class AgentTokensError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTokensError";
  }
}

export function parseAgentTokenMap(value: string): Map<string, string> {
  const entries = parseCsv(value);
  const map = new Map<string, string>();
  const seenTokens = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new AgentTokensError(
        "Invalid LIBRARIAN_AGENT_TOKENS entry. Use agent_id:token pairs separated by commas.",
      );
    }
    const agentId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (map.has(agentId)) {
      throw new AgentTokensError(`Duplicate LIBRARIAN_AGENT_TOKENS entry for agent ${agentId}.`);
    }
    if (seenTokens.has(token)) {
      throw new AgentTokensError(
        `Duplicate LIBRARIAN_AGENT_TOKENS token for agents ${seenTokens.get(token)} and ${agentId}.`,
      );
    }
    map.set(agentId, token);
    seenTokens.set(token, agentId);
  }
  return map;
}
