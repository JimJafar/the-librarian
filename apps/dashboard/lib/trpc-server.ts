import "server-only";
import type { AppRouter } from "@librarian/mcp-server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";

// ADR 0008 P2/P3: the admin tRPC API lives on its OWN internal listener, on a
// different host:port from the agent /mcp surface, and is TRUSTED — it grants
// admin with no bearer because it's reachable only over loopback / the internal
// docker network. So the dashboard's tRPC client targets LIBRARIAN_TRPC_URL (the
// base URL of that internal listener; we append /trpc below) and sends NO
// Authorization header. LIBRARIAN_TRPC_URL wins; LIBRARIAN_SERVER_URL is kept
// only as the dev fallback so a plain local run against a single server resolves.
export function resolveTrpcBaseUrl(): string {
  return process.env.LIBRARIAN_TRPC_URL ?? process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

// Surface misconfiguration once at cold start so admin tRPC calls
// don't silently fall back to the dev default without a clue why.
//
// EDGE-SAFE: despite `import "server-only"`, Next's middleware bundler pulls
// this module into the EDGE runtime (middleware.ts → auth-config-client.ts →
// here), where `process.stderr` is undefined — a `process.stderr.write` at
// module init would throw and 500 every request. `console.warn` is supported in
// the edge runtime, so use it (never `process.stderr`/`process.stdout` here).
if (!process.env.LIBRARIAN_TRPC_URL && !process.env.LIBRARIAN_SERVER_URL) {
  console.warn(
    `[trpc-server] LIBRARIAN_TRPC_URL (and LIBRARIAN_SERVER_URL fallback) unset; ` +
      `falling back to ${DEFAULT_SERVER_URL} (dev only).`,
  );
}

export function createServerTRPC() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${resolveTrpcBaseUrl()}/trpc`,
      }),
    ],
  });
}

export const serverTRPC = createServerTRPC();
