// Public surface of `@librarian/mcp-server`. The CLI imports the
// session formatters from here; downstream callers can also pull the
// dispatch / RPC handlers when embedding the MCP server in-process.

export {
  formatSessionDetail,
  formatSessionEvents,
  formatSessionLifecycle,
  formatSessionList,
  formatSessionSearch,
  formatSessionStart,
} from "./mcp/formatters.js";
export { dispatchMcp, tools } from "./mcp/dispatch.js";
export { handleMcpMessage, handleMcpPayload } from "./mcp/rpc.js";
export type { ToolContext, ToolDefinition, McpTextResult } from "./mcp/tool.js";
export type { AppRouter } from "./trpc/router.js";
