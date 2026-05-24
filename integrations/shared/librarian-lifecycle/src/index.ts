// @librarian/lifecycle — shared harness lifecycle helper.
//
// Privacy detection, local state, CLI wiring, and idempotent session
// automation used by every harness integration (Claude Code, Codex,
// Hermes, OpenCode, Pi). Dependency-light by design: it runs in several
// harness environments (§6).

export * from "./cli.js";
export * from "./privacy.js";
export * from "./state.js";
