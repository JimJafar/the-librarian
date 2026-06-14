// HTTP server factory.
//
// Composition root for the HTTP API: auth config + store →
// a configured `node:http` server. The bin entrypoint (bin/http.ts) owns
// env parsing, boot-time validation, and signal handling; this module
// just assembles the runtime pieces so the same server can be spun up
// from tests without spawning a subprocess.

import http from "node:http";
import type { LibrarianStore } from "@librarian/core";
import type { AuthConfig } from "./auth.js";
import { type RouteSurface, createRouteHandler } from "./routes.js";

export interface HttpServerOptions {
  store: LibrarianStore;
  auth: AuthConfig;
  maxBodyBytes?: number;
  /** Master key — threaded to the tRPC auth router for AUTH_SECRET / OAuth secrets. */
  secretKey?: Buffer | null;
  /**
   * Which surface this server serves (ADR 0008 P1). "public" (default) carries
   * the agent surface (/mcp, /healthz, /primer.md); "internal" carries only the
   * admin tRPC API (/trpc/*). The bin spins up one of each.
   */
  surface?: RouteSurface;
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  const handler = createRouteHandler({
    store: options.store,
    auth: options.auth,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    secretKey: options.secretKey ?? null,
    surface: options.surface ?? "public",
  });
  return http.createServer((req, res) => {
    void handler(req, res);
  });
}
