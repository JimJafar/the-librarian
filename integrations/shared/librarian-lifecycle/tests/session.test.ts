import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliSession, type LibrarianCli, LibrarianCliError } from "../src/cli.js";
import { createLibrarianLifecycle, type LifecycleDeps } from "../src/session.js";
import { loadState, type StateLocation } from "../src/state.js";

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-session-"));
});
afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

const location: StateLocation = {
  harness: "claude-code",
  harnessSessionKey: "sess-1",
  cwd: "/home/jim/code/the-librarian",
  projectKey: "the-librarian",
};

function fakeSession(over: Partial<CliSession> = {}): CliSession {
  return {
    id: "ses_1",
    status: "active",
    title: null,
    project_key: "the-librarian",
    source_ref: null,
    cwd: "/home/jim/code/the-librarian",
    ...over,
  };
}

function fakeCli(over: Partial<LibrarianCli> = {}): LibrarianCli {
  return {
    startSession: vi.fn(() => fakeSession()),
    listSessions: vi.fn(() => []),
    continueSession: vi.fn((id) => fakeSession({ id })),
    checkpointSession: vi.fn(),
    pauseSession: vi.fn(),
    endSession: vi.fn(),
    ...over,
  };
}

function make(over: Partial<LifecycleDeps> = {}) {
  const cli = over.cli ?? fakeCli();
  const deps: LifecycleDeps = {
    cli,
    location,
    stateOptions: { baseDir },
    now: () => Date.parse("2026-05-24T12:00:00.000Z"),
    ...over,
  };
  return { lifecycle: createLibrarianLifecycle(deps), cli };
}

describe("handlePrompt — start/resume (§5.2)", () => {
  it("starts a new session on the first public prompt when none match", () => {
    const { lifecycle, cli } = make();
    const out = lifecycle.handlePrompt("let's refactor the parser");
    expect(out.action).toBe("started");
    expect(out.sessionId).toBe("ses_1");
    expect(cli.startSession).toHaveBeenCalledTimes(1);
    expect(loadState(location, { baseDir })?.librarian_session_id).toBe("ses_1");
  });

  it("resumes when exactly one active/paused session matches", () => {
    const cli = fakeCli({ listSessions: vi.fn(() => [fakeSession({ id: "ses_existing" })]) });
    const { lifecycle } = make({ cli });
    const out = lifecycle.handlePrompt("back to work");
    expect(out.action).toBe("resumed");
    expect(out.sessionId).toBe("ses_existing");
    expect(cli.continueSession).toHaveBeenCalledWith("ses_existing");
    expect(cli.startSession).not.toHaveBeenCalled();
  });

  it("starts fresh (not guess) when multiple sessions match", () => {
    const cli = fakeCli({
      listSessions: vi.fn(() => [fakeSession({ id: "a" }), fakeSession({ id: "b" })]),
    });
    const { lifecycle } = make({ cli });
    expect(lifecycle.handlePrompt("hello").action).toBe("started");
    expect(cli.continueSession).not.toHaveBeenCalled();
  });

  it("is idempotent: a second prompt with a session attached does not start again", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("first");
    const out = lifecycle.handlePrompt("second");
    expect(out.action).toBe("active");
    expect(cli.startSession).toHaveBeenCalledTimes(1);
  });
});

describe("handlePrompt — privacy gate (§3.3, §4.3, §9)", () => {
  it("makes no Librarian call for a same-message private marker", () => {
    const { lifecycle, cli } = make();
    const out = lifecycle.handlePrompt("off the record, my password is hunter2");
    expect(out.action).toBe("entered-private");
    expect(out.privacy).toBe("private");
    expect(cli.startSession).not.toHaveBeenCalled();
    expect(loadState(location, { baseDir })?.privacy).toBe("private");
  });

  it("ends the attached session with a neutral reason on entering private, then makes no further calls", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("start work"); // attaches ses_1
    const out = lifecycle.handlePrompt("this is a private session");
    expect(out.action).toBe("entered-private");
    expect(cli.endSession).toHaveBeenCalledWith("ses_1", "switching to private mode");
    const state = loadState(location, { baseDir });
    expect(state?.privacy).toBe("private");
    expect(state?.librarian_session_id).toBeUndefined();
    // Subsequent ordinary prompt while private → no call.
    (cli.startSession as ReturnType<typeof vi.fn>).mockClear();
    const next = lifecycle.handlePrompt("more secret stuff");
    expect(next.action).toBe("suppressed-private");
    expect(cli.startSession).not.toHaveBeenCalled();
  });

  it("exit-private resumes public only from the next prompt", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("off the record"); // private
    const exit = lifecycle.handlePrompt("you can remember again, now fix the bug");
    expect(exit.action).toBe("exited-private");
    expect(exit.privacy).toBe("public");
    // This (exit) prompt did not start/resume.
    expect(cli.startSession).not.toHaveBeenCalled();
    // The NEXT public prompt starts.
    const next = lifecycle.handlePrompt("continue the fix");
    expect(next.action).toBe("started");
    expect(cli.startSession).toHaveBeenCalledTimes(1);
  });
});

describe("handleToggle (§3.1)", () => {
  it("toggles public→private (ending the attached session) and back", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("work"); // attached
    const toPriv = lifecycle.handleToggle();
    expect(toPriv.privacy).toBe("private");
    expect(cli.endSession).toHaveBeenCalledWith("ses_1", "switching to private mode");
    const toPub = lifecycle.handleToggle();
    expect(toPub.action).toBe("toggled-public");
    expect(toPub.privacy).toBe("public");
  });
});

describe("handleCheckpoint (§5.3)", () => {
  it("does nothing when no session is attached", () => {
    const { lifecycle, cli } = make();
    expect(lifecycle.handleCheckpoint({ trigger: "compaction" }).action).toBe("no-session");
    expect(cli.checkpointSession).not.toHaveBeenCalled();
  });

  it("checkpoints on a compaction boundary", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("work");
    expect(lifecycle.handleCheckpoint({ trigger: "compaction" }).action).toBe("checkpointed");
    expect(cli.checkpointSession).toHaveBeenCalledTimes(1);
  });

  it("skips a low-activity checkpoint below the gates", () => {
    const { lifecycle } = make();
    lifecycle.handlePrompt("work");
    expect(lifecycle.handleCheckpoint({ filesTouched: 1, toolCalls: 1 }).action).toBe(
      "skipped-gate",
    );
  });

  it("checkpoints once enough files were touched", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("work");
    expect(lifecycle.handleCheckpoint({ filesTouched: 3 }).action).toBe("checkpointed");
    expect(cli.checkpointSession).toHaveBeenCalledTimes(1);
  });

  it("makes no call while private", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("off the record");
    expect(lifecycle.handleCheckpoint({ trigger: "compaction" }).action).toBe("suppressed-private");
    expect(cli.checkpointSession).not.toHaveBeenCalled();
  });
});

describe("handlePause (§5.4)", () => {
  it("pauses and detaches so the next prompt resumes via list", () => {
    const cli = fakeCli();
    const { lifecycle } = make({ cli });
    lifecycle.handlePrompt("work"); // ses_1 attached
    const paused = lifecycle.handlePause();
    expect(paused.action).toBe("paused");
    expect(cli.pauseSession).toHaveBeenCalledWith("ses_1", expect.any(String));
    expect(loadState(location, { baseDir })?.librarian_session_id).toBeUndefined();
  });

  it("is idempotent when nothing is attached", () => {
    const { lifecycle, cli } = make();
    expect(lifecycle.handlePause().action).toBe("no-session");
    expect(cli.pauseSession).not.toHaveBeenCalled();
  });

  it("makes no call while private", () => {
    const { lifecycle, cli } = make();
    lifecycle.handlePrompt("off the record");
    expect(lifecycle.handlePause().action).toBe("suppressed-private");
    expect(cli.pauseSession).not.toHaveBeenCalled();
  });
});

describe("fail-closed + fail-soft (§9)", () => {
  it("suppresses all calls when local state cannot be read", () => {
    const cli = fakeCli();
    // Point state at a path that can't be created (a file where a dir is needed).
    const filePath = path.join(baseDir, "blocker");
    fs.writeFileSync(filePath, "x");
    const { lifecycle } = make({ cli, stateOptions: { baseDir: filePath } });
    const out = lifecycle.handlePrompt("work");
    expect(out.action).toBe("suppressed-error");
    expect(cli.startSession).not.toHaveBeenCalled();
  });

  it("logs but does not throw when the CLI fails", () => {
    const cli = fakeCli({
      startSession: vi.fn(() => {
        throw new LibrarianCliError("exit", "boom");
      }),
    });
    const logger = vi.fn();
    const { lifecycle } = make({ cli, logger });
    const out = lifecycle.handlePrompt("work");
    expect(out.action).toBe("error");
    expect(logger).toHaveBeenCalled();
  });

  it("is a no-op when disabled", () => {
    const cli = fakeCli();
    const { lifecycle } = make({ cli, config: { enabled: false } });
    expect(lifecycle.handlePrompt("work").action).toBe("disabled");
    expect(cli.startSession).not.toHaveBeenCalled();
  });
});
