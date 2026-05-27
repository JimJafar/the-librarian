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
export { createLogger, logger } from "./logging.js";
export type { ToolContext, ToolDefinition, McpTextResult } from "./mcp/tool.js";
export { appRouter, type AppRouter } from "./trpc/router.js";
export { createCallerFactory } from "./trpc/trpc.js";
export {
  type ClassifierWorker,
  type ClassifierWorkerDeps,
  type ProcessOutcome,
  IDLE_POLL_MS,
  MAX_ATTEMPTS,
  createClassifierWorker,
} from "./classifier-worker.js";
export {
  type BootClassifierWorkerInput,
  type BootedClassifierWorker,
  bootClassifierWorker,
  isClassifierRuntimeActive,
  __resetClassifierRuntimeForTests,
} from "./classifier-startup.js";
