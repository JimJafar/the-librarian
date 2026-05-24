#!/usr/bin/env node
// MCP stdio bin entrypoint.
//
// Reads newline-delimited JSON-RPC messages on stdin, dispatches them
// through `handleMcpMessage`, and writes responses to stdout. Roles
// come from `LIBRARIAN_STDIO_ROLE` / `LIBRARIAN_STDIO_AGENT_ID`.

import { createLibrarianStore, resolveOptionalSecretKey } from "@librarian/core";
import { handleMcpMessage } from "../mcp/rpc.js";

// LIBRARIAN_SECRET_KEY (optional) unlocks encrypted admin settings. Absent → no
// secret support; present-but-bad → fail loud (to stderr; stdout is the RPC channel).
let secretKey: Buffer | null;
try {
  secretKey = resolveOptionalSecretKey(process.env.LIBRARIAN_SECRET_KEY);
} catch (error) {
  process.stderr.write(`Invalid LIBRARIAN_SECRET_KEY: ${(error as Error).message}\n`);
  process.exit(1);
}
const store = createLibrarianStore({ secretKey });

process.stdin.setEncoding("utf8");

let buffer = "";
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    void handleLine(line);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function handleLine(line: string): Promise<void> {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${(error as Error).message}` },
    });
    return;
  }

  const method = message.method as string | undefined;
  if (!message.id && method?.startsWith("notifications/")) return;

  const response = await handleMcpMessage(store, message, {
    role: (process.env.LIBRARIAN_STDIO_ROLE as "admin" | "agent" | undefined) || "agent",
    agentId: process.env.LIBRARIAN_STDIO_AGENT_ID || undefined,
  });
  if (response) send(response);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function shutdown(): void {
  store.close();
  process.exit(0);
}
