// HTTP server factory.
//
// Composition root for the HTTP API: auth config + store + public dir →
// a configured `node:http` server. The bin entrypoint (bin/http.ts) owns
// env parsing, boot-time validation, and signal handling; this module
// just assembles the runtime pieces so the same server can be spun up
// from tests without spawning a subprocess.

import http from "node:http";
import type { LibrarianStore } from "@librarian/core";
import type { AuthConfig } from "./auth.js";
import { createRouteHandler } from "./routes.js";

export interface HttpServerOptions {
  store: LibrarianStore;
  auth: AuthConfig;
  publicDir: string;
  maxBodyBytes?: number;
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  const handler = createRouteHandler({
    store: options.store,
    auth: options.auth,
    publicDir: options.publicDir,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
  });
  return http.createServer((req, res) => {
    void handler(req, res);
  });
}
