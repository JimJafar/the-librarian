// Claude Code harness adapter (spec §7.1).
//
// Translates Claude Code hook events into shared-lifecycle calls. The mapping
// is verified against the real Claude Code hook surface:
//
//   UserPromptSubmit → handlePrompt   (privacy gate + start/resume)
//   PostCompact      → checkpoint(compaction)   — high-value boundary
//   TaskCompleted    → checkpoint(task-completed)
//   SessionEnd       → pause           (never end, §5.4)
//   SessionStart     → no-op           (state is lazily created on the first
//                                        meaningful prompt — opening a tool
//                                        should not create a session, §5.1)
//   Stop / anything  → no-op           (optional heartbeat, skipped for v1)
//
// The privacy gate does NOT block the prompt from reaching the model — it only
// suppresses the Librarian call. Because this adapter is the only thing that
// calls the Librarian on a prompt, a hook crash is inherently fail-closed:
// nothing is recorded for that turn.

import { type LibrarianCli, createLibrarianCli } from "../cli.js";
import {
  type CheckpointOutcome,
  type LibrarianLifecycle,
  type LifecycleConfig,
  type LifecycleDeps,
  type LifecycleLogEntry,
  type PauseOutcome,
  type PromptOutcome,
  createLibrarianLifecycle,
} from "../session.js";
import type { StateLocation } from "../state.js";

export interface ClaudeHookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  reason?: string;
  trigger?: string;
}

export type ClaudeHookResult =
  | PromptOutcome
  | CheckpointOutcome
  | PauseOutcome
  | { action: "ignored" };

// Build the state location. Local state is keyed per Claude session_id, but the
// Librarian session is matched by cwd (+project) — a coding harness resumes by
// directory, not by a per-session source_ref that would never match across
// Claude sessions (§5.2). So sourceRef is intentionally left unset.
export function claudeLocationFromEvent(
  event: ClaudeHookEvent,
  env: NodeJS.ProcessEnv,
): StateLocation {
  const location: StateLocation = {
    harness: "claude-code",
    // session_id is present on every event that drives a CLI call
    // (UserPromptSubmit/PostCompact/TaskCompleted/SessionEnd); cwd and the
    // final literal are should-never-happen sentinels for degenerate events
    // that never reach the Librarian anyway.
    harnessSessionKey: event.session_id ?? event.cwd ?? "claude-code",
  };
  if (event.cwd) location.cwd = event.cwd;
  if (env.LIBRARIAN_PROJECT_KEY) location.projectKey = env.LIBRARIAN_PROJECT_KEY;
  return location;
}

export function dispatchClaudeHook(
  event: ClaudeHookEvent,
  lifecycle: LibrarianLifecycle,
): ClaudeHookResult {
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return lifecycle.handlePrompt(event.prompt ?? "");
    case "PostCompact":
      return lifecycle.handleCheckpoint({ trigger: "compaction" });
    case "TaskCompleted":
      return lifecycle.handleCheckpoint({ trigger: "task-completed" });
    case "SessionEnd":
      return lifecycle.handlePause();
    default:
      return { action: "ignored" };
  }
}

export interface ClaudeCodeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<LifecycleConfig>;
  /** Injectable for tests; defaults to a real spawnSync-backed CLI. */
  cli?: LibrarianCli;
  logger?: (entry: LifecycleLogEntry) => void;
  now?: () => number;
}

export function createClaudeCodeLifecycle(
  event: ClaudeHookEvent,
  options: ClaudeCodeAdapterOptions = {},
): LibrarianLifecycle {
  const env = options.env ?? process.env;
  const location = claudeLocationFromEvent(event, env);
  const agent = env.LIBRARIAN_AGENT_ID || "claude-code";
  // The spawn cwd is deliberately the same value as the location's match cwd
  // (§5.2) — keep them in lockstep if either is ever changed.
  const cli =
    options.cli ?? createLibrarianCli({ agent, ...(event.cwd ? { cwd: event.cwd } : {}) });
  const deps: LifecycleDeps = { cli, location };
  if (options.config) deps.config = options.config;
  if (options.logger) deps.logger = options.logger;
  if (options.now) deps.now = options.now;
  return createLibrarianLifecycle(deps);
}
