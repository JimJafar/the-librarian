import { describe, expect, it, vi } from "vitest";
import {
  type ClaudeHookEvent,
  claudeLocationFromEvent,
  dispatchClaudeHook,
} from "../src/harness/claude-code.js";
import type { LibrarianLifecycle } from "../src/session.js";

function fakeLifecycle(): LibrarianLifecycle {
  return {
    handlePrompt: vi.fn(() => ({ action: "started" as const, privacy: "public" as const })),
    handleCheckpoint: vi.fn(() => ({ action: "checkpointed" as const })),
    handlePause: vi.fn(() => ({ action: "paused" as const })),
    handleToggle: vi.fn(() => ({ action: "toggled-public" as const, privacy: "public" as const })),
  };
}

describe("dispatchClaudeHook (§7.1 mapping)", () => {
  it("routes UserPromptSubmit to handlePrompt with the prompt text", () => {
    const lc = fakeLifecycle();
    dispatchClaudeHook({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug" }, lc);
    expect(lc.handlePrompt).toHaveBeenCalledWith("fix the bug");
  });

  it("routes PostCompact to a compaction checkpoint", () => {
    const lc = fakeLifecycle();
    dispatchClaudeHook({ hook_event_name: "PostCompact" }, lc);
    expect(lc.handleCheckpoint).toHaveBeenCalledWith({ trigger: "compaction" });
  });

  it("routes TaskCompleted to a task-completed checkpoint", () => {
    const lc = fakeLifecycle();
    dispatchClaudeHook({ hook_event_name: "TaskCompleted" }, lc);
    expect(lc.handleCheckpoint).toHaveBeenCalledWith({ trigger: "task-completed" });
  });

  it("routes SessionEnd to handlePause", () => {
    const lc = fakeLifecycle();
    dispatchClaudeHook({ hook_event_name: "SessionEnd", reason: "other" }, lc);
    expect(lc.handlePause).toHaveBeenCalledTimes(1);
  });

  it("ignores SessionStart and Stop (no lifecycle mutation)", () => {
    const lc = fakeLifecycle();
    expect(
      dispatchClaudeHook({ hook_event_name: "SessionStart", source: "startup" }, lc).action,
    ).toBe("ignored");
    expect(dispatchClaudeHook({ hook_event_name: "Stop" }, lc).action).toBe("ignored");
    expect(lc.handlePrompt).not.toHaveBeenCalled();
    expect(lc.handleCheckpoint).not.toHaveBeenCalled();
    expect(lc.handlePause).not.toHaveBeenCalled();
  });

  it("ignores an unknown event rather than throwing", () => {
    const lc = fakeLifecycle();
    expect(dispatchClaudeHook({ hook_event_name: "PreToolUse" }, lc).action).toBe("ignored");
  });

  it("treats a missing prompt as empty string", () => {
    const lc = fakeLifecycle();
    dispatchClaudeHook({ hook_event_name: "UserPromptSubmit" }, lc);
    expect(lc.handlePrompt).toHaveBeenCalledWith("");
  });
});

describe("claudeLocationFromEvent", () => {
  const event: ClaudeHookEvent = {
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-abc",
    cwd: "/home/jim/code/the-librarian",
  };

  it("keys local state per Claude session and matches the Librarian session by cwd", () => {
    const loc = claudeLocationFromEvent(event, {});
    expect(loc.harness).toBe("claude-code");
    expect(loc.harnessSessionKey).toBe("claude-abc");
    expect(loc.cwd).toBe("/home/jim/code/the-librarian");
    // No per-session source_ref — that would block cross-session resume (§5.2).
    expect(loc.sourceRef).toBeUndefined();
  });

  it("takes the project key from the environment when provided", () => {
    const loc = claudeLocationFromEvent(event, { LIBRARIAN_PROJECT_KEY: "the-librarian" });
    expect(loc.projectKey).toBe("the-librarian");
  });

  it("falls back to the session_id when cwd is absent", () => {
    const loc = claudeLocationFromEvent({ hook_event_name: "Stop", session_id: "x" }, {});
    expect(loc.harnessSessionKey).toBe("x");
  });
});
