#!/usr/bin/env node
import { createLibrarianStore } from "@librarian/core";
import { handleMcpMessage } from "../mcp/dispatch.js";

const store = createLibrarianStore();

process.stdin.setEncoding("utf8");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    handleLine(line);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${error.message}` },
    });
    return;
  }

  if (!message.id && message.method?.startsWith("notifications/")) return;

  const response = await handleMcpMessage(store, message, {
    role: process.env.LIBRARIAN_STDIO_ROLE || "agent",
    agentId: process.env.LIBRARIAN_STDIO_AGENT_ID || "",
  });
  if (response) send(response);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function shutdown() {
  store.close();
  process.exit(0);
}
