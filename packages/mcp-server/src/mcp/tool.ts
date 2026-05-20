// MCP tool registry types.
//
// Each tool under `./tools/` exports a default `ToolDefinition` —
// `dispatch.ts` builds a name→definition map from these and dispatches
// `tools/call` requests through it.

import type { LibrarianStore } from "@librarian/core";

export interface ToolContext {
  role: "admin" | "agent";
  agentId?: string | undefined;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpTextResult {
  content: McpTextContent[];
}

export type ToolHandler = (
  store: LibrarianStore,
  args: Record<string, unknown>,
  context: ToolContext,
) => McpTextResult | Promise<McpTextResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  adminOnly?: boolean;
  handler: ToolHandler;
}
