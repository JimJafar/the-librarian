// Codex harness adapter (spec §7.3).
//
// Codex is first-class when hooks are enabled (`[features] hooks = true`): it
// ships a real synchronous UserPromptSubmit hook that runs before the prompt is
// processed — a genuine pre-agent privacy gate. Its hook stdin JSON mirrors
// Claude Code's (session_id, cwd, hook_event_name, prompt), so the mapping is
// the same shape with two differences:
//
//   - Codex has NO SessionEnd and NO TaskCompleted event. Pause-on-exit is
//     handled by integrations/codex/wrapper.sh's exit trap, not a hook.
//   - Compaction checkpointing uses PostCompact (PreCompact is left a no-op to
//     avoid double-checkpointing).
//
// Mapping:
//   UserPromptSubmit → handlePrompt   (privacy gate + start/resume)
//   PostCompact      → checkpoint(compaction)
//   SessionStart / PreCompact / Stop / other → no-op
//
// Like Claude Code, the gate does NOT block the prompt — privacy means "no
// Librarian call", not "stop the model".

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

export interface CodexHookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  trigger?: string;
}

export type CodexHookResult =
  | PromptOutcome
  | CheckpointOutcome
  | PauseOutcome
  | { action: "ignored" };

// Local state keyed per Codex session_id; the Librarian session is matched by
// cwd (+project), not a per-session source_ref that could never match across
// Codex sessions (§5.2). Kept consistent with the Claude Code adapter.
export function codexLocationFromEvent(
  event: CodexHookEvent,
  env: NodeJS.ProcessEnv,
): StateLocation {
  const location: StateLocation = {
    harness: "codex",
    harnessSessionKey: event.session_id ?? event.cwd ?? "codex",
  };
  if (event.cwd) location.cwd = event.cwd;
  if (env.LIBRARIAN_PROJECT_KEY) location.projectKey = env.LIBRARIAN_PROJECT_KEY;
  return location;
}

export function dispatchCodexHook(
  event: CodexHookEvent,
  lifecycle: LibrarianLifecycle,
): CodexHookResult {
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return lifecycle.handlePrompt(event.prompt ?? "");
    case "PostCompact":
      return lifecycle.handleCheckpoint({ trigger: "compaction" });
    default:
      return { action: "ignored" };
  }
}

export interface CodexAdapterOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<LifecycleConfig>;
  /** Injectable for tests; defaults to a real spawnSync-backed CLI. */
  cli?: LibrarianCli;
  logger?: (entry: LifecycleLogEntry) => void;
  now?: () => number;
}

export function createCodexLifecycle(
  event: CodexHookEvent,
  options: CodexAdapterOptions = {},
): LibrarianLifecycle {
  const env = options.env ?? process.env;
  const location = codexLocationFromEvent(event, env);
  const agent = env.LIBRARIAN_AGENT_ID || "codex";
  const cli =
    options.cli ?? createLibrarianCli({ agent, ...(event.cwd ? { cwd: event.cwd } : {}) });
  const deps: LifecycleDeps = { cli, location };
  if (options.config) deps.config = options.config;
  if (options.logger) deps.logger = options.logger;
  if (options.now) deps.now = options.now;
  return createLibrarianLifecycle(deps);
}
