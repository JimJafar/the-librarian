import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { type CliRunResult, createLibrarianCli, LibrarianCliError } from "../src/cli.js";

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

function cliWith(run: (args: string[]) => CliRunResult, overrides = {}) {
  const calls: string[][] = [];
  const wrapped = (args: string[]) => {
    calls.push(args);
    return run(args);
  };
  const cli = createLibrarianCli({ agent: "guybrush", ...overrides }, { run: wrapped });
  return { cli, calls };
}

describe("createLibrarianCli — startSession", () => {
  it("builds the start argv with --agent, --harness, and --json and parses the session", () => {
    const { cli, calls } = cliWith(() => ok({ session }));
    const result = cli.startSession({
      harness: "claude-code",
      cwd: "/home/jim/code/the-librarian",
      projectKey: "the-librarian",
      summary: "starting work",
    });
    expect(result.id).toBe("ses_abc");
    const args = calls[0]!;
    expect(args.slice(0, 2)).toEqual(["sessions", "start"]);
    expect(args).toContain("--agent");
    expect(args).toContain("guybrush");
    expect(args).toEqual(expect.arrayContaining(["--harness", "claude-code"]));
    expect(args).toEqual(expect.arrayContaining(["--project", "the-librarian"]));
    expect(args).toEqual(expect.arrayContaining(["--start-summary", "starting work"]));
    expect(args).toContain("--json");
  });

  it("omits optional flags that were not provided", () => {
    const { cli, calls } = cliWith(() => ok({ session }));
    cli.startSession({ harness: "codex" });
    const args = calls[0]!;
    expect(args).not.toContain("--source-ref");
    expect(args).not.toContain("--project");
    expect(args).not.toContain("--start-summary");
  });

  it("throws a parse error when the store returns no session", () => {
    const { cli } = cliWith(() => ok({ session: null }));
    expect(() => cli.startSession({ harness: "pi" })).toThrow(LibrarianCliError);
  });
});

describe("createLibrarianCli — listSessions", () => {
  it("defaults to active+paused status and parses the sessions array", () => {
    const { cli, calls } = cliWith(() => ok({ sessions: [session], total: 1, limit: 20 }));
    const result = cli.listSessions({ cwd: "/home/jim/code/the-librarian" });
    expect(result.map((s) => s.id)).toEqual(["ses_abc"]);
    const args = calls[0]!;
    const statusFlags = args.filter((_, i) => args[i - 1] === "--status");
    expect(statusFlags).toEqual(["active", "paused"]);
  });

  it("honours explicit statuses", () => {
    const { cli, calls } = cliWith(() => ok({ sessions: [], total: 0, limit: 20 }));
    cli.listSessions({ statuses: ["paused"] });
    const args = calls[0]!;
    expect(args.filter((_, i) => args[i - 1] === "--status")).toEqual(["paused"]);
  });
});

describe("createLibrarianCli — continueSession", () => {
  it("passes the id, agent, and --json", () => {
    const { cli, calls } = cliWith(() => ok({ session, handover: {}, text: "", format: "prose" }));
    const result = cli.continueSession("ses_abc");
    expect(result.id).toBe("ses_abc");
    const args = calls[0]!;
    expect(args.slice(0, 3)).toEqual(["sessions", "continue", "ses_abc"]);
    expect(args).toContain("--json");
  });
});

describe("createLibrarianCli — checkpoint/pause use --summary-file", () => {
  it("writes the summary to a temp file, passes --summary-file, and cleans it up", () => {
    let seenPath: string | undefined;
    let seenContent: string | undefined;
    const { cli, calls } = cliWith((args) => {
      const i = args.indexOf("--summary-file");
      seenPath = args[i + 1];
      seenContent = fs.readFileSync(seenPath!, "utf8");
      return ok({ session });
    });
    cli.checkpointSession("ses_abc", "did the thing");
    expect(seenContent).toBe("did the thing");
    expect(calls[0]!.slice(0, 3)).toEqual(["sessions", "checkpoint", "ses_abc"]);
    expect(fs.existsSync(seenPath!)).toBe(false); // cleaned up
  });

  it("pause writes its summary file too", () => {
    let seen: string | undefined;
    const { cli } = cliWith((args) => {
      const i = args.indexOf("--summary-file");
      seen = fs.readFileSync(args[i + 1]!, "utf8");
      return ok({ session: { ...session, status: "paused" } });
    });
    cli.pauseSession("ses_abc", "switching off");
    expect(seen).toBe("switching off");
  });

  it("removes the summary temp file even when the call fails", () => {
    let seenPath: string | undefined;
    const { cli } = cliWith((args) => {
      seenPath = args[args.indexOf("--summary-file") + 1];
      return { stdout: "", stderr: "nope", status: 1 };
    });
    expect(() => cli.checkpointSession("ses_abc", "x")).toThrow(LibrarianCliError);
    expect(fs.existsSync(seenPath!)).toBe(false);
  });
});

describe("createLibrarianCli — endSession", () => {
  it("ends with an inline --summary reason", () => {
    const { cli, calls } = cliWith(() => ok({ session: { ...session, status: "ended" } }));
    cli.endSession("ses_abc", "switching to private mode");
    const args = calls[0]!;
    expect(args.slice(0, 3)).toEqual(["sessions", "end", "ses_abc"]);
    expect(args).toEqual(expect.arrayContaining(["--summary", "switching to private mode"]));
  });
});

describe("createLibrarianCli — error mapping", () => {
  it("maps a non-zero exit to a LibrarianCliError with stderr", () => {
    const { cli } = cliWith(() => ({ stdout: "", stderr: "boom", status: 1 }));
    try {
      cli.listSessions({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LibrarianCliError);
      expect((err as LibrarianCliError).kind).toBe("exit");
      expect((err as LibrarianCliError).stderr).toBe("boom");
    }
  });

  it("maps a spawn failure to kind=spawn", () => {
    const { cli } = cliWith(() => ({
      stdout: "",
      stderr: "",
      status: null,
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    }));
    expect(() => cli.listSessions({})).toThrow(expect.objectContaining({ kind: "spawn" }));
  });

  it("maps a spawnSync timeout (ETIMEDOUT + null status) to kind=timeout", () => {
    const { cli } = cliWith(() => ({
      stdout: "",
      stderr: "",
      status: null,
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    }));
    expect(() => cli.listSessions({})).toThrow(expect.objectContaining({ kind: "timeout" }));
  });

  it("maps a bare null status (signal kill, no error) to kind=timeout", () => {
    const { cli } = cliWith(() => ({ stdout: "", stderr: "", status: null }));
    expect(() => cli.listSessions({})).toThrow(expect.objectContaining({ kind: "timeout" }));
  });

  it("maps malformed JSON to kind=parse", () => {
    const { cli } = cliWith(() => ({ stdout: "not json", stderr: "", status: 0 }));
    expect(() => cli.listSessions({})).toThrow(expect.objectContaining({ kind: "parse" }));
  });
});
