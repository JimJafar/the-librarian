import { describe, expect, it, vi } from "vitest";
import {
  type CodexHookEvent,
  codexLocationFromEvent,
  dispatchCodexHook,
} from "../src/harness/codex.js";
import type { LibrarianLifecycle } from "../src/session.js";

function fakeLifecycle(): LibrarianLifecycle {
  return {
    handlePrompt: vi.fn(() => ({ action: "started" as const, privacy: "public" as const })),
    handleCheckpoint: vi.fn(() => ({ action: "checkpointed" as const })),
    handlePause: vi.fn(() => ({ action: "paused" as const })),
    handleToggle: vi.fn(() => ({ action: "toggled-public" as const, privacy: "public" as const })),
  };
}

describe("dispatchCodexHook (§7.3 mapping)", () => {
  it("routes UserPromptSubmit to handlePrompt with the prompt text", () => {
    const lc = fakeLifecycle();
    dispatchCodexHook({ hook_event_name: "UserPromptSubmit", prompt: "ship it" }, lc);
    expect(lc.handlePrompt).toHaveBeenCalledWith("ship it");
  });

  it("routes PostCompact to a compaction checkpoint", () => {
    const lc = fakeLifecycle();
    dispatchCodexHook({ hook_event_name: "PostCompact", trigger: "auto" }, lc);
    expect(lc.handleCheckpoint).toHaveBeenCalledWith({ trigger: "compaction" });
  });

  it("ignores events Codex does not provide for lifecycle (no SessionEnd / TaskCompleted)", () => {
    const lc = fakeLifecycle();
    // Codex has no SessionEnd; pause is handled by the wrapper exit trap.
    expect(
      dispatchCodexHook({ hook_event_name: "SessionStart", source: "startup" }, lc).action,
    ).toBe("ignored");
    expect(dispatchCodexHook({ hook_event_name: "PreCompact", trigger: "manual" }, lc).action).toBe(
      "ignored",
    );
    expect(dispatchCodexHook({ hook_event_name: "Stop" }, lc).action).toBe("ignored");
    expect(lc.handlePause).not.toHaveBeenCalled();
    expect(lc.handleCheckpoint).not.toHaveBeenCalled();
  });

  it("treats a missing prompt as empty string", () => {
    const lc = fakeLifecycle();
    dispatchCodexHook({ hook_event_name: "UserPromptSubmit" }, lc);
    expect(lc.handlePrompt).toHaveBeenCalledWith("");
  });
});

describe("codexLocationFromEvent", () => {
  const event: CodexHookEvent = {
    hook_event_name: "UserPromptSubmit",
    session_id: "codex-abc",
    cwd: "/home/jim/code/the-librarian",
  };

  it("uses the codex harness, keys state per session, matches by cwd", () => {
    const loc = codexLocationFromEvent(event, {});
    expect(loc.harness).toBe("codex");
    expect(loc.harnessSessionKey).toBe("codex-abc");
    expect(loc.cwd).toBe("/home/jim/code/the-librarian");
    expect(loc.sourceRef).toBeUndefined();
  });

  it("takes the project key from the environment", () => {
    const loc = codexLocationFromEvent(event, { LIBRARIAN_PROJECT_KEY: "the-librarian" });
    expect(loc.projectKey).toBe("the-librarian");
  });
});
