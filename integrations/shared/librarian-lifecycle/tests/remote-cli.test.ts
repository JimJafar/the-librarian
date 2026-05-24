import { describe, expect, it } from "vitest";
import { type CliRunResult, LibrarianCliError } from "../src/cli.js";
import { type RemoteRunner, createRemoteLibrarianCli } from "../src/remote-cli.js";

function ok(json: unknown): CliRunResult {
  return { stdout: JSON.stringify(json), stderr: "", status: 0 };
}

const session = {
  id: "ses_abc",
  status: "active",
  title: "Work",
  project_key: "the-librarian",
  source_ref: null,
  cwd: "/home/jim/code/the-librarian",
};

function remoteWith(run: RemoteRunner, config = {}) {
  const calls: { verb: string; args: Record<string, unknown> }[] = [];
  const wrapped: RemoteRunner = (verb, input) => {
    calls.push({ verb, args: JSON.parse(input) });
    return run(verb, input);
  };
  const cli = createRemoteLibrarianCli(config, { run: wrapped });
  return { cli, calls };
}

describe("createRemoteLibrarianCli — startSession", () => {
  it("invokes the start verb with the mapped args and parses the session", () => {
    const { cli, calls } = remoteWith(() => ok({ session }));
    const result = cli.startSession({
      harness: "claude-code",
      cwd: "/home/jim/code/the-librarian",
      projectKey: "the-librarian",
      summary: "starting work",
      title: "Work",
    });
    expect(result.id).toBe("ses_abc");
    expect(calls[0]!.verb).toBe("start");
    expect(calls[0]!.args).toMatchObject({
      harness: "claude-code",
      cwd: "/home/jim/code/the-librarian",
      projectKey: "the-librarian",
      summary: "starting work",
      title: "Work",
    });
  });

  it("throws a parse error when the helper returns no session", () => {
    const { cli } = remoteWith(() => ok({ session: null }));
    expect(() => cli.startSession({ harness: "pi" })).toThrow(LibrarianCliError);
  });
});

describe("createRemoteLibrarianCli — listSessions", () => {
  it("invokes the list verb with default statuses and maps the array", () => {
    const { cli, calls } = remoteWith(() =>
      ok({ sessions: [session, { ...session, id: "ses_two" }] }),
    );
    const result = cli.listSessions({ harness: "claude-code", cwd: "/x" });
    expect(result.map((s) => s.id)).toEqual(["ses_abc", "ses_two"]);
    expect(calls[0]!.verb).toBe("list");
    expect(calls[0]!.args.statuses).toEqual(["active", "paused"]);
  });

  it("returns [] when the helper reports no sessions", () => {
    const { cli } = remoteWith(() => ok({ sessions: [] }));
    expect(cli.listSessions({ harness: "codex" })).toEqual([]);
  });

  it("passes through explicit statuses", () => {
    const { cli, calls } = remoteWith(() => ok({ sessions: [] }));
    cli.listSessions({ harness: "codex", statuses: ["active"] });
    expect(calls[0]!.args.statuses).toEqual(["active"]);
  });
});

describe("createRemoteLibrarianCli — continueSession", () => {
  it("invokes the continue verb with the session id and config attach targets", () => {
    const { cli, calls } = remoteWith(() => ok({ session }), {
      harness: "claude-code",
      cwd: "/home/jim/code/the-librarian",
    });
    const result = cli.continueSession("ses_abc");
    expect(result.id).toBe("ses_abc");
    expect(calls[0]!.verb).toBe("continue");
    expect(calls[0]!.args).toMatchObject({
      sessionId: "ses_abc",
      harness: "claude-code",
      cwd: "/home/jim/code/the-librarian",
    });
  });
});

describe("createRemoteLibrarianCli — checkpoint/pause/end", () => {
  it("invokes checkpoint with the summary", () => {
    const { cli, calls } = remoteWith(() => ok({ ok: true }));
    cli.checkpointSession("ses_abc", "did things");
    expect(calls[0]!).toMatchObject({
      verb: "checkpoint",
      args: { sessionId: "ses_abc", summary: "did things" },
    });
  });

  it("invokes pause with the summary", () => {
    const { cli, calls } = remoteWith(() => ok({ ok: true }));
    cli.pauseSession("ses_abc", "paused");
    expect(calls[0]!).toMatchObject({
      verb: "pause",
      args: { sessionId: "ses_abc", summary: "paused" },
    });
  });

  it("invokes end with the reason", () => {
    const { cli, calls } = remoteWith(() => ok({ ok: true }));
    cli.endSession("ses_abc", "switching to private mode");
    expect(calls[0]!).toMatchObject({
      verb: "end",
      args: { sessionId: "ses_abc", reason: "switching to private mode" },
    });
  });
});

describe("createRemoteLibrarianCli — error mapping", () => {
  it("maps a spawn failure to a typed spawn error", () => {
    const { cli } = remoteWith(() => ({
      stdout: "",
      stderr: "",
      status: null,
      error: Object.assign(new Error("nope"), { code: "ENOENT" }),
    }));
    const err = (() => {
      try {
        cli.startSession({ harness: "pi" });
        return null;
      } catch (e) {
        return e as LibrarianCliError;
      }
    })();
    expect(err).toBeInstanceOf(LibrarianCliError);
    expect(err?.kind).toBe("spawn");
  });

  it("maps a timeout (status null, ETIMEDOUT) to a timeout error", () => {
    const { cli } = remoteWith(() => ({
      stdout: "",
      stderr: "",
      status: null,
      error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }),
    }));
    expect(() => cli.startSession({ harness: "pi" })).toThrow(
      expect.objectContaining({ kind: "timeout" }),
    );
  });

  it("maps a non-zero exit to an exit error carrying the code", () => {
    const { cli } = remoteWith(() => ({ stdout: "", stderr: "boom", status: 2 }));
    const err = (() => {
      try {
        cli.startSession({ harness: "pi" });
        return null;
      } catch (e) {
        return e as LibrarianCliError;
      }
    })();
    expect(err?.kind).toBe("exit");
    expect(err?.exitCode).toBe(2);
  });

  it("maps invalid JSON to a parse error", () => {
    const { cli } = remoteWith(() => ({ stdout: "not json", stderr: "", status: 0 }));
    expect(() => cli.startSession({ harness: "pi" })).toThrow(
      expect.objectContaining({ kind: "parse" }),
    );
  });
});
