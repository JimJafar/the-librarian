import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// Mirrors the claude-code bin contract: the codex hook must ALWAYS exit 0 and
// emit no stdout, and the LOCAL transport (default — no LIBRARIAN_MCP_URL) is
// selected and degrades cleanly when the CLI is unreachable. Runs the built bin.
const codexBinPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "bin",
  "codex-hook.js",
);

function runCodexBin(input: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lib-codex-bin-home-"));
  try {
    return spawnSync(process.execPath, [codexBinPath], {
      input,
      encoding: "utf8",
      // No LIBRARIAN_MCP_URL → local transport; the fake bin makes it unreachable.
      env: { ...process.env, HOME: home, LIBRARIAN_CLI_BIN: "definitely-not-a-real-binary-xyz" },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("codex-hook bin contract", () => {
  it("exits 0 with no stdout for an ignored event", () => {
    const r = runCodexBin(JSON.stringify({ hook_event_name: "SessionStart", session_id: "c" }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exits 0 with no stdout for a prompt even when the local CLI is unreachable", () => {
    const r = runCodexBin(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "c",
        cwd: "/tmp/lib-codex-x",
        prompt: "hi",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
