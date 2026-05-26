// @librarian/lifecycle — shared harness lifecycle helper.
//
// Privacy detection, local state, CLI wiring, and idempotent session
// automation. Currently used by the Claude Code in-tree integration and
// the OpenCode wrapper. Codex graduated to a standalone plugin
// (the-librarian-codex-plugin) that ships its own bundled hook; the
// harness/codex.ts adapter that used to live here was removed when its
// only consumer (integrations/codex/) moved out.

export * from "./cli.js";
export * from "./harness/claude-code.js";
export * from "./mcp-client.js";
export * from "./privacy.js";
export * from "./remote-cli.js";
export * from "./session.js";
export * from "./state.js";
export * from "./transport.js";
