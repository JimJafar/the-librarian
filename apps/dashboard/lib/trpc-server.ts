import "server-only";
import type { AppRouter } from "@librarian/mcp-server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";

// ADR 0008 P2: the admin tRPC API lives on its OWN internal listener, on a
// different host:port from the agent /mcp surface. The dashboard's tRPC client
// therefore targets LIBRARIAN_TRPC_URL — the base URL of that internal listener
// (it already points at the /trpc-serving host:port; we append /trpc below, as
// before). LIBRARIAN_TRPC_URL wins; LIBRARIAN_SERVER_URL is kept only as the dev
// fallback so a plain local run against a single server still resolves.
export function resolveTrpcBaseUrl(): string {
  return process.env.LIBRARIAN_TRPC_URL ?? process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

function authHeaders(): Record<string, string> {
  const token = process.env.LIBRARIAN_ADMIN_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Surface misconfiguration once at cold start so admin-gated procedures
// don't silently return 401 in T6.3+ without a clue why.
if (!process.env.LIBRARIAN_TRPC_URL && !process.env.LIBRARIAN_SERVER_URL) {
  process.stderr.write(
    `[trpc-server] LIBRARIAN_TRPC_URL (and LIBRARIAN_SERVER_URL fallback) unset; ` +
      `falling back to ${DEFAULT_SERVER_URL} (dev only).\n`,
  );
}
if (!process.env.LIBRARIAN_ADMIN_TOKEN) {
  process.stderr.write(
    "[trpc-server] LIBRARIAN_ADMIN_TOKEN unset; admin tRPC calls will receive 401 until set.\n",
  );
}

export function createServerTRPC() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${resolveTrpcBaseUrl()}/trpc`,
        headers: authHeaders,
      }),
    ],
  });
}

export const serverTRPC = createServerTRPC();
