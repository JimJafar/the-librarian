import "server-only";
import type { AppRouter } from "@librarian/mcp-server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

function resolveServerUrl(): string {
  return process.env.LIBRARIAN_SERVER_URL ?? "http://127.0.0.1:3838";
}

function authHeaders(): Record<string, string> {
  const token = process.env.LIBRARIAN_ADMIN_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
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
