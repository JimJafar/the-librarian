// tRPC context.
//
// Resolves the caller's admin role from the `LIBRARIAN_ADMIN_TOKEN`
// bearer. Reuses the existing MCP auth path so token comparison stays
// in one place. The `store` is threaded through so the feature routers
// (memories, handoffs, …) can call it without reaching for globals.

import type { LibrarianStore, LlmClient } from "@librarian/core";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { type AuthConfig, authenticateMcp } from "../http/auth.js";

export type TrpcRole = "admin" | "anonymous";

/** Build an LLM client from a resolved connection + token (the curator.chat seam). */
export type BuildChatClient = (
  conn: { endpoint: string; model: string; timeoutMs: number },
  token: string,
) => LlmClient;

export interface TrpcContext {
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

export function createContextFactory(
  deps: TrpcContextDeps,
): (opts: CreateHTTPContextOptions) => TrpcContext {
  return function createContext({ req }) {
    const result = authenticateMcp(req, deps.auth);
    return {
      role: result?.role === "admin" ? "admin" : "anonymous",
      store: deps.store,
      secretKey: deps.secretKey,
      adminToken: deps.auth.adminToken,
      ...(deps.buildChatClient ? { buildChatClient: deps.buildChatClient } : {}),
    };
  };
}
