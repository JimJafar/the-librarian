// HTTP auth + origin gating for the MCP server.
//
// Pure functions over a `AuthConfig` record. Boot-time validation lives
// in `bin/http.ts`; this module only resolves requests against an
// already-validated config so it stays unit-testable.

import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface AuthConfig {
  adminToken: string;
  agentToken: string;
  agentTokenMap: Map<string, string>;
  allowedOrigins: string[];
  host: string;
  port: number;
}

export interface AuthResult {
  role: "admin" | "agent";
  agentId?: string;
}

export function authenticateMcp(req: IncomingMessage, config: AuthConfig): AuthResult | null {
  if (!config.adminToken) return { role: "admin" };
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  for (const [agentId, mappedToken] of config.agentTokenMap) {
    if (timingSafeEqual(token, mappedToken)) return { role: "agent", agentId };
  }
  if (config.agentToken && timingSafeEqual(token, config.agentToken)) return { role: "agent" };
  if (timingSafeEqual(token, config.adminToken)) return { role: "admin" };
  return null;
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
