// tRPC context.
//
// Resolves the caller's admin role from the `LIBRARIAN_ADMIN_TOKEN`
// bearer. Reuses the existing MCP auth path so token comparison stays
// in one place. The `store` is threaded through so future routers
// (memories, sessions) can call it without reaching for globals.

import type { LibrarianStore } from "@librarian/core";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { type AuthConfig, authenticateMcp } from "../http/auth.js";

export type TrpcRole = "admin" | "anonymous";

export interface TrpcContext {
  role: TrpcRole;
  store: LibrarianStore;
}

export interface TrpcContextDeps {
  store: LibrarianStore;
  auth: AuthConfig;
}

export function createContextFactory(
  deps: TrpcContextDeps,
): (opts: CreateHTTPContextOptions) => TrpcContext {
  return function createContext({ req }) {
    const result = authenticateMcp(req, deps.auth);
    return {
      role: result?.role === "admin" ? "admin" : "anonymous",
      store: deps.store,
    };
  };
}
