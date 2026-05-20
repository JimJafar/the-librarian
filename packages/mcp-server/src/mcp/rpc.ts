// JSON-RPC 2.0 envelope wrappers around `dispatchMcp`.
//
// Single-message: `handleMcpMessage` validates the envelope, runs the
// dispatch, and folds the result (or error) back into a response.
// Batch: `handleMcpPayload` accepts an array, runs each entry in
// sequence, and returns the array of responses (notifications drop).

import type { LibrarianStore } from "@librarian/core";
import { dispatchMcp } from "./dispatch.js";
import type { ToolContext } from "./tool.js";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

type DispatchContext = { role?: ToolContext["role"]; agentId?: string | undefined };

export async function handleMcpMessage(
  store: LibrarianStore,
  message: JsonRpcMessage,
  context: DispatchContext = {},
): Promise<JsonRpcResponse | null> {
  if (!message || message.jsonrpc !== "2.0") {
    return rpcError(message?.id ?? null, -32600, "Invalid JSON-RPC request");
  }
  try {
    const result = await dispatchMcp(store, message.method || "", message.params || {}, context);
    if (message.id === undefined) return null;
    return { jsonrpc: "2.0", id: message.id ?? null, result };
  } catch (error) {
    if (message.id === undefined) return null;
    return rpcError(message.id ?? null, -32000, (error as Error).message);
  }
}

export async function handleMcpPayload(
  store: LibrarianStore,
  payload: JsonRpcMessage | JsonRpcMessage[],
  context: DispatchContext = {},
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    const responses: JsonRpcResponse[] = [];
    for (const message of payload) {
      const response = await handleMcpMessage(store, message, context);
      if (response) responses.push(response);
    }
    return responses;
  }
  return handleMcpMessage(store, payload, context);
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
