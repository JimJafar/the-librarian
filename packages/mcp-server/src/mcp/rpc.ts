// JSON-RPC 2.0 envelope wrappers around `dispatchMcp`.
//
// Single-message: `handleMcpMessage` validates the envelope, runs the
// dispatch, and folds the result (or error) back into a response.
// Batch: `handleMcpPayload` accepts an array, runs each entry in
// sequence, and returns the array of responses (notifications drop).

import type { LibrarianStore } from "@librarian/core";
import { type DispatchContext, dispatchMcp } from "./dispatch.js";
import type { ToolRegistry } from "./tool.js";
import { coreToolRegistry } from "./tools/index.js";

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

export async function handleMcpMessage(
  store: LibrarianStore,
  message: JsonRpcMessage,
  context: DispatchContext = {},
  // The tool registry to dispatch through; defaults to the core registry so the
  // stdio bin and existing callers are unchanged (spec 060 T3).
  registry: ToolRegistry = coreToolRegistry,
): Promise<JsonRpcResponse | null> {
  if (!message || message.jsonrpc !== "2.0") {
    return rpcError(message?.id ?? null, -32600, "Invalid JSON-RPC request");
  }
  try {
    const result = await dispatchMcp(
      store,
      message.method || "",
      message.params || {},
      context,
      registry,
    );
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
  // Threaded to `handleMcpMessage`; defaults to the core registry (spec 060 T3).
  registry: ToolRegistry = coreToolRegistry,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    const responses: JsonRpcResponse[] = [];
    for (const message of payload) {
      const response = await handleMcpMessage(store, message, context, registry);
      if (response) responses.push(response);
    }
    return responses;
  }
  return handleMcpMessage(store, payload, context, registry);
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
