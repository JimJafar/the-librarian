// Public surface of `@librarian/mcp-server`. Downstream callers can pull
// the dispatch / RPC handlers when embedding the MCP server in-process.
//
// sessions-rethink PR 7 — the formatSession* helpers in `mcp/formatters.ts`
// were retired with the rest of the session subsystem.

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
export { PACKAGE_VERSION } from "./version.js";
export {
  type LatestRelease,
  type LatestReleaseStatus,
  getLatestRelease,
  __resetLatestReleaseCacheForTests,
} from "./github-release.js";
