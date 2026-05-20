import "server-only";
import type { AppRouter } from "@librarian/mcp-server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";

function resolveServerUrl(): string {
  return process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

function authHeaders(): Record<string, string> {
  const token = process.env.LIBRARIAN_ADMIN_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Surface misconfiguration once at cold start so admin-gated procedures
// don't silently return 401 in T6.3+ without a clue why.
if (!process.env.LIBRARIAN_SERVER_URL) {
  process.stderr.write(
    `[trpc-server] LIBRARIAN_SERVER_URL unset; falling back to ${DEFAULT_SERVER_URL} (dev only).\n`,
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
        url: `${resolveServerUrl()}/trpc`,
        headers: authHeaders,
      }),
    ],
  });
}

export const serverTRPC = createServerTRPC();
