// HTTP server factory.
//
// Composition root for the HTTP API: auth config + store →
// a configured `node:http` server. The bin entrypoint (bin/http.ts) owns
// env parsing, boot-time validation, and signal handling; this module
// just assembles the runtime pieces so the same server can be spun up
// from tests without spawning a subprocess.

import http from "node:http";
import type { InternalLibrarianStore } from "@librarian/core";
import type { AuthConfig } from "./auth.js";
import { createRouteHandler } from "./routes.js";

export interface HttpServerOptions {
  store: InternalLibrarianStore;
  auth: AuthConfig;
  maxBodyBytes?: number;
  /** Master key — threaded to the tRPC auth router for AUTH_SECRET / OAuth secrets. */
  secretKey?: Buffer | null;
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  const handler = createRouteHandler({
    store: options.store,
    auth: options.auth,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    secretKey: options.secretKey ?? null,
  });
  return http.createServer((req, res) => {
    void handler(req, res);
  });
}
