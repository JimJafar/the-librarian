// Remote LibrarianCli transport (spec §8, remote deployment).
//
// A drop-in `LibrarianCli` that talks to a REMOTE Librarian over HTTP instead of
// the local `the-librarian` CLI. The lifecycle is deliberately synchronous (the
// state lock is a cross-process lockfile held across the session-resolving call),
// so this keeps the synchronous `LibrarianCli` shape and bridges to the async
// HTTP client over a subprocess — exactly as the local CLI transport bridges to
// the local store via `spawnSync`. Each verb spawns the `mcp-call` helper bin,
// which performs ONE MCP `tools/call` and prints CliSession-shaped JSON.
//
// Failures surface as `LibrarianCliError` (the same type the local CLI throws)
// so the orchestration's fail-soft `guard()` treats both transports identically.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type CliRunResult,
  type CliSession,
  type LibrarianCli,
  type SessionStatus,
  LibrarianCliError,
  toCliSession,
} from "./cli.js";
import type { Harness } from "./state.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/** Run the helper for `verb` with a JSON `input` payload on stdin. */
export type RemoteRunner = (verb: string, input: string) => CliRunResult;

export interface RemoteLibrarianCliConfig {
  /** Attach-target harness for `continueSession` (the interface passes only an id). */
  harness?: Harness;
  /** Attach-target cwd for `continueSession`. */
  cwd?: string;
  /** Attach-target source_ref for `continueSession`. */
  sourceRef?: string;
  /**
   * Path to the bundled `mcp-call` helper. Defaults to `$LIBRARIAN_MCP_CALL_BIN`
   * (set by the plugin to its bundled artifact), else this package's own dist bin.
   */
  mcpCallBin?: string;
  /** Node executable used to run the helper (default `process.execPath`). */
  nodeBin?: string;
  timeoutMs?: number;
  /** Environment for the spawned helper (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the spawned helper. */
  spawnCwd?: string;
}

export interface RemoteLibrarianCliDeps {
  run?: RemoteRunner;
}

function resolveHelperBin(config: RemoteLibrarianCliConfig): string {
  return (
    config.mcpCallBin ??
    process.env.LIBRARIAN_MCP_CALL_BIN ??
    fileURLToPath(new URL("./bin/mcp-call.js", import.meta.url))
  );
}

function defaultRunner(config: RemoteLibrarianCliConfig): RemoteRunner {
  const nodeBin = config.nodeBin ?? process.execPath;
  const helperBin = resolveHelperBin(config);
  return (verb, input) => {
    const res = spawnSync(nodeBin, [helperBin, verb], {
      input,
      encoding: "utf8",
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // The helper reads LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN from this env.
      // No failure path surfaces env contents — LibrarianCliError carries only
      // stderr/exitCode/verb.
      env: config.env ?? process.env,
      cwd: config.spawnCwd,
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

// Drop keys whose value is undefined so optional flags aren't sent as JSON nulls.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function createRemoteLibrarianCli(
  config: RemoteLibrarianCliConfig = {},
  deps: RemoteLibrarianCliDeps = {},
): LibrarianCli {
  const run = deps.run ?? defaultRunner(config);

  // Run a helper verb and parse its JSON, mapping every failure mode onto a
  // typed LibrarianCliError — identical contract to cli.ts's runJson so the
  // orchestration's guard() handles local and remote transports the same way.
  function runJson(verb: string, args: Record<string, unknown>): unknown {
    const res = run(verb, JSON.stringify(compact(args)));
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      const kind = code === "ETIMEDOUT" ? "timeout" : "spawn";
      const what = kind === "timeout" ? "timed out" : `failed to spawn: ${res.error.message}`;
      throw new LibrarianCliError(kind, `librarian-mcp-call ${verb} ${what}`, {
        stderr: res.stderr,
      });
    }
    if (res.status === null) {
      throw new LibrarianCliError("timeout", `librarian-mcp-call ${verb} was killed (signal)`, {
        stderr: res.stderr,
      });
    }
    if (res.status !== 0) {
      throw new LibrarianCliError("exit", `librarian-mcp-call ${verb} exited ${res.status}`, {
        exitCode: res.status,
        stderr: res.stderr,
      });
    }
    try {
      return JSON.parse(res.stdout);
    } catch (err) {
      throw new LibrarianCliError(
        "parse",
        `librarian-mcp-call ${verb} returned invalid JSON: ${(err as Error).message}`,
      );
    }
  }

  return {
    startSession(args) {
      const parsed = runJson("start", {
        harness: args.harness,
        sourceRef: args.sourceRef,
        cwd: args.cwd,
        projectKey: args.projectKey,
        summary: args.summary,
        title: args.title,
      }) as { session?: unknown };
      return toCliSession(parsed.session, "start");
    },

    listSessions(args) {
      const statuses: SessionStatus[] = args.statuses ?? ["active", "paused"];
      const parsed = runJson("list", {
        harness: args.harness,
        sourceRef: args.sourceRef,
        cwd: args.cwd,
        projectKey: args.projectKey,
        statuses,
      }) as { sessions?: unknown };
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return sessions.map((s) => toCliSession(s, "list"));
    },

    continueSession(sessionId): CliSession {
      const parsed = runJson("continue", {
        sessionId,
        harness: config.harness,
        cwd: config.cwd,
        sourceRef: config.sourceRef,
      }) as { session?: unknown };
      return toCliSession(parsed.session, "continue");
    },

    checkpointSession(sessionId, summary) {
      runJson("checkpoint", { sessionId, summary });
    },

    pauseSession(sessionId, summary) {
      runJson("pause", { sessionId, summary });
    },

    endSession(sessionId, reason) {
      runJson("end", { sessionId, reason });
    },
  };
}
