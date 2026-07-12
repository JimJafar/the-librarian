// Public surface of `@librarian/mcp-server`. Downstream callers can pull
// the dispatch / RPC handlers when embedding the MCP server in-process.
//
// sessions-rethink PR 7 — the formatSession* helpers in `mcp/formatters.ts`
// were retired with the rest of the session subsystem.

export {
  type LibrarianServer,
  type LibrarianServerOptions,
  type LibrarianServerInternals,
  createLibrarianServer,
} from "./librarian-server.js";
// The build-time plugin envelope (ADR 0011 seam S1, spec 060). The dedicated
// `@librarian/mcp-server/extension` entrypoint that stabilises the full seam
// surface is spec 060 T6; for now the type rides the main entrypoint because
// `LibrarianServerOptions.plugins` references it.
export type { LibrarianPlugin } from "./plugin.js";
export { dispatchMcp, tools } from "./mcp/dispatch.js";
export { handleMcpMessage, handleMcpPayload } from "./mcp/rpc.js";
export { createLogger, logger } from "./logging.js";
export type { ToolContext, ToolDefinition, McpTextResult } from "./mcp/tool.js";
export { appRouter, type AppRouter } from "./trpc/router.js";
export { createCallerFactory } from "./trpc/trpc.js";
export { PACKAGE_VERSION } from "./version.js";
export {
  type LatestRelease,
  type LatestReleaseStatus,
  getLatestRelease,
  __resetLatestReleaseCacheForTests,
} from "./github-release.js";
