// tRPC context.
//
// Resolves the caller's admin role from the `LIBRARIAN_ADMIN_TOKEN`
// bearer. Reuses the existing MCP auth path so token comparison stays
// in one place. The `store` is threaded through so future routers
// (memories, sessions) can call it without reaching for globals.

import type { InternalLibrarianStore } from "@librarian/core";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { type AuthConfig, authenticateMcp } from "../http/auth.js";

export type TrpcRole = "admin" | "anonymous";

export interface TrpcContext {
  role: TrpcRole;
  store: InternalLibrarianStore;
  /** Master key for deriving AUTH_SECRET / decrypting OAuth secrets (null when unset). */
  secretKey: Buffer | null;
  /** The configured admin token — the auth router compares it timing-safe in `enable`. */
  adminToken: string;
}

export interface TrpcContextDeps {
  store: InternalLibrarianStore;
  auth: AuthConfig;
  secretKey: Buffer | null;
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
    };
  };
}
