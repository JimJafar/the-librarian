// tRPC context.
//
// The tRPC API is served ONLY on the internal listener (ADR 0008 P1), which is
// trusted — loopback / internal-docker-network only, never published. So the
// context resolves the trusted admin `Principal` for every caller WITHOUT a
// bearer (ADR 0008 P3): the socket is the gate, not a token. The principal is
// resolved through T1's `defaultAuthProvider` on the "internal" surface — the
// SAME single per-surface identity point the /mcp route uses (spec 061 T3) — so
// the seam stays in one place and T4 can swap the provider slot here without
// touching this factory. The `store` is threaded through so the feature routers
// (memories, handoffs, …) can call it without reaching for globals.

import type { LibrarianStore, LlmClient, Principal } from "@librarian/core";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { type AuthConfig, defaultAuthProvider } from "../http/auth.js";

export type TrpcRole = "admin" | "anonymous";

/** Build an LLM client from a resolved connection + token (the curator.chat seam). */
export type BuildChatClient = (
  conn: { endpoint: string; model: string; timeoutMs: number },
  token: string,
) => LlmClient;

export interface TrpcContext {
  /**
   * The resolved caller (spec 061 SC 5) — the one identity currency new code reads.
   * On the internal listener this is the trusted admin principal (admin-by-isolation,
   * ADR 0008 P3); `adminProcedure` gates on `principal.roles`, and dashboard writes
   * derive their actor from `principal.actorId` (default `dashboard-admin`).
   */
  principal: Principal;
  /** @deprecated derive from `principal`: `principal.roles.includes("admin") ? "admin" : "anonymous"`. */
  role: TrpcRole;
  store: LibrarianStore;
  /** Master key for deriving AUTH_SECRET / decrypting OAuth secrets (null when unset). */
  secretKey: Buffer | null;
  /** The configured admin token — the auth router compares it timing-safe in `enable`. */
  adminToken: string;
  /**
   * Optional injectable LLM-client builder for `curator.chat` (D6b). Production
   * leaves it unset (the procedure builds the real OpenAI-compatible client); a test
   * can inject a scripted client. A pure seam — never serialised, never logged.
   */
  buildChatClient?: BuildChatClient;
}

export interface TrpcContextDeps {
  store: LibrarianStore;
  auth: AuthConfig;
  secretKey: Buffer | null;
  /** Optional injectable LLM-client builder for curator.chat (test seam). */
  buildChatClient?: BuildChatClient;
}

/**
 * A role-less principal for the (unreachable with the default provider) internal
 * refusal. The internal surface is admin-by-isolation (ADR 0008 P3), so
 * `defaultAuthProvider` always resolves it to admin; failing CLOSED here preserves
 * the old `null → "anonymous"` mapping — a refusal is rejected by every
 * `adminProcedure` (401), never a 500 and never silently admitted.
 */
const ANONYMOUS_PRINCIPAL: Principal = { kind: "agent", actorId: "anonymous", roles: [] };

export function createContextFactory(
  deps: TrpcContextDeps,
): (opts: CreateHTTPContextOptions) => TrpcContext {
  return function createContext({ req }) {
    // "internal" surface → trusted admin (the listener is the boundary, ADR 0008 P3).
    const outcome = defaultAuthProvider(deps.auth).authenticate(req, "internal");
    const principal = outcome.ok ? outcome.principal : ANONYMOUS_PRINCIPAL;
    return {
      principal,
      role: principal.roles.includes("admin") ? "admin" : "anonymous",
      store: deps.store,
      secretKey: deps.secretKey,
      adminToken: deps.auth.adminToken,
      ...(deps.buildChatClient ? { buildChatClient: deps.buildChatClient } : {}),
    };
  };
}
