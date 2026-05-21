// Shared response helpers for MCP tool handlers.
//
// `textResult` wraps a plain string in the MCP "content" envelope.

import type { McpTextResult } from "./tool.js";

export function textResult(text: string): McpTextResult {
  return {
    content: [{ type: "text", text }],
  };
}
