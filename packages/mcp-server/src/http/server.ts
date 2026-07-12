// HTTP server factory.
//
// Composition root for the HTTP API: auth config + store →
// a configured `node:http` server. The bin entrypoint (bin/http.ts) owns
// env parsing, boot-time validation, and signal handling; this module
// just assembles the runtime pieces so the same server can be spun up
// from tests without spawning a subprocess.

import http from "node:http";
import type { LibrarianStore } from "@librarian/core";
import type { AnyRouter } from "@trpc/server";
import type { ToolRegistry } from "../mcp/tool.js";
import { coreToolRegistry } from "../mcp/tools/index.js";
import { appRouter } from "../trpc/router.js";
import type { AuthConfig } from "./auth.js";
import { type PluginRoute, type RouteSurface, createRouteHandler } from "./routes.js";

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
  /**
   * The MCP tool registry the /mcp route dispatches through (spec 060 T3). The
   * factory passes a merged core+plugin registry; defaults to the core registry so
   * existing callers keep exactly today's tool surface.
   */
  toolRegistry?: ToolRegistry;
  /**
   * The tRPC router the internal listener's /trpc/* adapter serves (spec 060 T4).
   * The factory passes a merged core+plugin router (`buildAppRouter`); defaults to
   * the core `appRouter` so existing callers keep exactly today's admin surface.
   * Ignored on the public surface, which never mounts /trpc (ADR 0008 P1).
   */
  trpcRouter?: AnyRouter;
  /**
   * Plugin-contributed HTTP routes (spec 060 T5). The factory passes the whole
   * validated set to each listener; the route handler serves only the ones whose
   * `surface` matches. Defaults to none, so existing callers keep today's route set.
   */
  pluginRoutes?: readonly PluginRoute[];
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  const handler = createRouteHandler({
    store: options.store,
    auth: options.auth,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    secretKey: options.secretKey ?? null,
    surface: options.surface ?? "public",
    toolRegistry: options.toolRegistry ?? coreToolRegistry,
    trpcRouter: options.trpcRouter ?? appRouter,
    pluginRoutes: options.pluginRoutes ?? [],
  });
  const server = http.createServer((req, res) => {
    // A client that disconnects mid-response makes the next `res`/socket write
    // EPIPE. Node throws on an UNHANDLED stream 'error', so without these guards a
    // dropped client crashes the whole server process. A client must never be able
    // to kill the server — swallow per-request stream errors (the request is
    // already dead; nothing sensitive is logged).
    req.on("error", () => {});
    res.on("error", () => {});
    void handler(req, res);
  });
  // A malformed request line / TLS junk / a disconnect before the response surfaces
  // as 'clientError'. Close the socket cleanly rather than letting it bubble.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  // Backstop: any connection-level socket error (an RST/EPIPE during teardown, a
  // half-open peer) is swallowed so a dropped client can never crash the server.
  server.on("connection", (socket) => {
    socket.on("error", () => {});
  });
  return server;
}
