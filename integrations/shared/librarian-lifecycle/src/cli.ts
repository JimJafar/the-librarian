// The Librarian CLI wrapper (spec §8).
//
// Hook scripts prefer the CLI over MCP, especially on shutdown paths where
// MCP may be slow or unavailable during process teardown (§8). This module
// is the single place that knows the `the-librarian sessions …` flag
// contract, so every harness adapter spawns it the same way and parses the
// same JSON.
//
// The runner is injectable so the orchestration tests never spawn a real
// binary; the default uses spawnSync because hooks run as short-lived,
// synchronous processes.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Harness } from "./state.js";

export interface CliRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null when killed by signal/timeout. */
  status: number | null;
  /** Spawn failure (e.g. binary not found), if any. */
  error?: Error;
}

export type CliRunner = (args: string[]) => CliRunResult;

export interface LibrarianCliConfig {
  /** Canonical agent id for attribution (--agent). */
  agent: string;
  /** CLI binary; defaults to $LIBRARIAN_CLI_BIN or "the-librarian". */
  bin?: string;
  /** Per-call timeout for the default runner. */
  timeoutMs?: number;
  /** Environment for the spawned process (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the spawned process. */
  cwd?: string;
}

export interface LibrarianCliDeps {
  run?: CliRunner;
  /** Directory for transient --summary-file payloads (test override). */
  tmpDir?: string;
}

export type CliErrorKind = "spawn" | "timeout" | "exit" | "parse";

export class LibrarianCliError extends Error {
  override readonly name = "LibrarianCliError";
  readonly kind: CliErrorKind;
  readonly exitCode?: number | undefined;
  readonly stderr?: string | undefined;

  constructor(
    kind: CliErrorKind,
    message: string,
    extra: { exitCode?: number | null; stderr?: string } = {},
  ) {
    super(message);
    this.kind = kind;
    this.exitCode = extra.exitCode ?? undefined;
    this.stderr = extra.stderr;
  }
}

/** A session as the lifecycle helper needs it — a thin view over the CLI JSON. */
export interface CliSession {
  id: string;
  status: string;
  title: string | null;
  project_key: string | null;
  source_ref: string | null;
  cwd: string | null;
}

export type SessionStatus = "active" | "paused" | "ended";

export interface StartSessionArgs {
  harness: Harness;
  sourceRef?: string;
  cwd?: string;
  projectKey?: string;
  summary?: string;
  title?: string;
}

export interface ListSessionsArgs {
  harness?: Harness;
  sourceRef?: string;
  cwd?: string;
  projectKey?: string;
  /** Defaults to active + paused — automation never attaches ended sessions (§5.2). */
  statuses?: SessionStatus[];
}

export interface LibrarianCli {
  startSession(args: StartSessionArgs): CliSession;
  listSessions(args: ListSessionsArgs): CliSession[];
  continueSession(sessionId: string): CliSession;
  checkpointSession(sessionId: string, summary: string): void;
  pauseSession(sessionId: string, summary: string): void;
  /** End a session with a short content-free reason (the §4.3 private-transition end). */
  endSession(sessionId: string, reason: string): void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function defaultRunner(config: LibrarianCliConfig): CliRunner {
  const bin = config.bin ?? process.env.LIBRARIAN_CLI_BIN ?? "the-librarian";
  return (args) => {
    const res = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Full env passthrough is deliberate: the CLI needs LIBRARIAN_SECRET_KEY
      // and the DB path from the environment. No failure path surfaces env
      // contents — LibrarianCliError carries only stderr/exitCode/verb.
      env: config.env ?? process.env,
      cwd: config.cwd,
      maxBuffer: MAX_BUFFER,
    });
    const result: CliRunResult = {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      status: res.status,
    };
    if (res.error) result.error = res.error;
    return result;
  };
}

function pushFlag(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined && value !== "") args.push(flag, value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toCliSession(raw: unknown, context: string): CliSession {
  if (typeof raw !== "object" || raw === null) {
    throw new LibrarianCliError("parse", `${context}: response had no session`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.status !== "string") {
    throw new LibrarianCliError("parse", `${context}: session is missing id/status`);
  }
  return {
    id: s.id,
    status: s.status,
    title: asString(s.title),
    project_key: asString(s.project_key),
    source_ref: asString(s.source_ref),
    cwd: asString(s.cwd),
  };
}

export function createLibrarianCli(
  config: LibrarianCliConfig,
  deps: LibrarianCliDeps = {},
): LibrarianCli {
  const run = deps.run ?? defaultRunner(config);
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const agentFlags = ["--agent", config.agent];

  // Run a JSON command and return the parsed object, mapping every failure
  // mode onto a typed LibrarianCliError the caller can log and fail-soft on.
  // The verb is passed explicitly rather than read from argv[1] so the error
  // text stays correct regardless of argv shape.
  function runJson(verb: string, args: string[]): unknown {
    const res = run([...args, "--json"]);
    if (res.error) {
      // spawnSync reports a timeout via error.code === "ETIMEDOUT" *and*
      // status === null, so the timeout must be distinguished here, before
      // the generic spawn-failure branch, or every timeout reads as "spawn".
      const code = (res.error as NodeJS.ErrnoException).code;
      const kind: CliErrorKind = code === "ETIMEDOUT" ? "timeout" : "spawn";
      const what = kind === "timeout" ? "timed out" : `failed to spawn: ${res.error.message}`;
      throw new LibrarianCliError(kind, `the-librarian ${verb} ${what}`, { stderr: res.stderr });
    }
    if (res.status === null) {
      throw new LibrarianCliError("timeout", `the-librarian ${verb} was killed (signal)`, {
        stderr: res.stderr,
      });
    }
    if (res.status !== 0) {
      throw new LibrarianCliError("exit", `the-librarian ${verb} exited ${res.status}`, {
        exitCode: res.status,
        stderr: res.stderr,
      });
    }
    try {
      return JSON.parse(res.stdout);
    } catch (err) {
      throw new LibrarianCliError(
        "parse",
        `the-librarian ${verb} returned invalid JSON: ${(err as Error).message}`,
      );
    }
  }

  // checkpoint/pause take their summary via a temp file (§8) so a long
  // summary never bloats argv. The file is 0600 and removed after the call,
  // even if it throws.
  function withSummaryFile<T>(summary: string, fn: (file: string) => T): T {
    const file = path.join(tmpDir, `librarian-summary-${process.pid}-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(file, summary, { mode: 0o600 });
    // writeFileSync's mode is umask-masked at create time; chmod guarantees
    // 0600 so a summary (which can carry sensitive work context) is never
    // left world-readable under a permissive umask. Mirrors state.ts.
    fs.chmodSync(file, 0o600);
    try {
      return fn(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  return {
    startSession(args) {
      const argv = ["sessions", "start", ...agentFlags, "--harness", args.harness];
      pushFlag(argv, "--source-ref", args.sourceRef);
      pushFlag(argv, "--cwd", args.cwd);
      pushFlag(argv, "--project", args.projectKey);
      pushFlag(argv, "--start-summary", args.summary);
      pushFlag(argv, "--title", args.title);
      const parsed = runJson("start", argv) as { session?: unknown };
      return toCliSession(parsed.session, "start");
    },

    listSessions(args) {
      const argv = ["sessions", "list", ...agentFlags];
      pushFlag(argv, "--harness", args.harness);
      pushFlag(argv, "--source-ref", args.sourceRef);
      pushFlag(argv, "--cwd", args.cwd);
      pushFlag(argv, "--project", args.projectKey);
      for (const status of args.statuses ?? ["active", "paused"]) {
        argv.push("--status", status);
      }
      const parsed = runJson("list", argv) as { sessions?: unknown };
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return sessions.map((s) => toCliSession(s, "list"));
    },

    // The continue payload also carries handover/text/format, but the
    // lifecycle helper only needs the attached session here; callers that
    // want the handover prose use MCP continue_session / the slash command.
    continueSession(sessionId) {
      const parsed = runJson("continue", ["sessions", "continue", sessionId, ...agentFlags]) as {
        session?: unknown;
      };
      return toCliSession(parsed.session, "continue");
    },

    checkpointSession(sessionId, summary) {
      withSummaryFile(summary, (file) => {
        runJson("checkpoint", [
          "sessions",
          "checkpoint",
          sessionId,
          ...agentFlags,
          "--summary-file",
          file,
        ]);
      });
    },

    pauseSession(sessionId, summary) {
      withSummaryFile(summary, (file) => {
        runJson("pause", ["sessions", "pause", sessionId, ...agentFlags, "--summary-file", file]);
      });
    },

    endSession(sessionId, reason) {
      // The reason is short and content-free ("switching to private mode"),
      // so it goes inline via --summary rather than a temp file.
      runJson("end", ["sessions", "end", sessionId, ...agentFlags, "--summary", reason]);
    },
  };
}
