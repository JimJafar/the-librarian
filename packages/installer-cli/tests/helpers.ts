// Test helpers: a throwaway HOME dir so nothing touches the real
// `~/.librarian`. Every test gets its own temp dir, removed after.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOptions, RunResult, Runner } from "../src/exec.js";
import { resetCodexCaptureFetcher, setCodexCaptureFetcher } from "../src/harnesses/codex.js";
import type { StreamHandlers, Streamer } from "../src/server/docker.js";

/** Run `fn` with a fresh temp home dir, cleaned up afterwards. */
export async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-cli-test-"));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Register an OFFLINE Codex capture-adapter fetcher so the orchestration tests'
 * `codex.install` (which now also wires the per-turn auto-capture hooks, spec
 * 2026-06-16-harness-auto-capture Phase 2A) never reaches the network. Returns a
 * cleanup fn that restores the default fetcher and removes the fixture dir; call
 * it (or `resetCodexCaptureFetcher`) in afterEach. The fixture mimics the fetched
 * `integrations/codex/` tree (scripts/ + hooks/codex-hooks.json with the
 * ${LIBRARIAN_CODEX_ROOT} placeholder + the owner marker).
 */
export function useOfflineCodexCapture(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-capture-fixture-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "on-stop.mjs"), "// entry\n");
  fs.writeFileSync(
    path.join(root, "hooks", "codex-hooks.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "${LIBRARIAN_CODEX_ROOT}/scripts/on-stop.mjs" # the-librarian-codex',
                timeout: 15,
              },
            ],
          },
        ],
      },
    }),
  );
  setCodexCaptureFetcher(async () => root);
  return () => {
    resetCodexCaptureFetcher();
    fs.rmSync(root, { recursive: true, force: true });
  };
}

/** A single recorded invocation of the stub runner. */
export interface RunCall {
  cmd: string;
  args: string[];
  opts: RunOptions | undefined;
}

/**
 * A scriptable, recording stub for the `exec` Runner. Tests configure
 * which binaries are "on PATH" and what `run` returns per command, then
 * assert against `calls`. Nothing spawns a real process.
 */
export class FakeRunner implements Runner {
  /** Every `run` invocation, in order. */
  readonly calls: RunCall[] = [];
  /** Commands resolvable by `which` (others resolve to null). */
  private readonly present = new Set<string>();
  /** Per-command canned results, matched by `cmd` + args.join(" "). */
  private readonly scripted = new Map<string, RunResult>();
  /** Fallback result when no script matches. */
  private fallback: RunResult = { stdout: "", stderr: "", code: 0 };

  /** Mark a binary as present on PATH (so `which` resolves it). */
  withWhich(cmd: string): this {
    this.present.add(cmd);
    return this;
  }

  /** Script the result for an exact `cmd args…` invocation. */
  onRun(cmd: string, args: readonly string[], result: Partial<RunResult>): this {
    this.scripted.set(key(cmd, args), { stdout: "", stderr: "", code: 0, ...result });
    return this;
  }

  /** Set the default result for any unscripted `run`. */
  withFallback(result: Partial<RunResult>): this {
    this.fallback = { stdout: "", stderr: "", code: 0, ...result };
    return this;
  }

  async run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult> {
    this.calls.push({ cmd, args: [...args], opts });
    return this.scripted.get(key(cmd, args)) ?? this.fallback;
  }

  async which(cmd: string): Promise<string | null> {
    return this.present.has(cmd) ? `/usr/bin/${cmd}` : null;
  }

  /** Convenience: did any recorded call run exactly `cmd args…`? */
  ran(cmd: string, args: readonly string[]): boolean {
    return this.calls.some((c) => c.cmd === cmd && c.args.join(" ") === [...args].join(" "));
  }
}

function key(cmd: string, args: readonly string[]): string {
  return `${cmd} ${[...args].join(" ")}`;
}

/** A single recorded invocation of the stub streamer. */
export interface StreamCall {
  cmd: string;
  args: string[];
  opts: RunOptions | undefined;
}

/**
 * A scriptable, recording stub for the streaming seam (`docker logs -f`). It
 * models a follow process: when `stream` is called it emits each scripted
 * stdout/stderr chunk to the handlers IN ORDER (live, not batched at the end),
 * then resolves with the scripted exit code — mimicking the process exiting
 * (container stop / Ctrl-C). Nothing spawns a real process.
 */
export class FakeStreamer implements Streamer {
  /** Every `stream` invocation, in order. */
  readonly calls: StreamCall[] = [];
  /** stdout chunks emitted, in order, on every `stream` call. */
  private stdoutChunks: string[] = [];
  /** stderr chunks emitted, in order, on every `stream` call. */
  private stderrChunks: string[] = [];
  /** The exit code the followed process resolves with. */
  private exitCode: number | null = 0;

  /** Script the stdout chunks emitted (each forwarded to `onStdout` in turn). */
  withStdout(...chunks: string[]): this {
    this.stdoutChunks = chunks;
    return this;
  }

  /** Script the stderr chunks emitted (each forwarded to `onStderr` in turn). */
  withStderr(...chunks: string[]): this {
    this.stderrChunks = chunks;
    return this;
  }

  /** Set the exit code the followed process resolves with (default 0). */
  withExit(code: number | null): this {
    this.exitCode = code;
    return this;
  }

  async stream(
    cmd: string,
    args: readonly string[],
    handlers: StreamHandlers,
    opts?: RunOptions,
  ): Promise<number | null> {
    this.calls.push({ cmd, args: [...args], opts });
    for (const chunk of this.stdoutChunks) handlers.onStdout?.(chunk);
    for (const chunk of this.stderrChunks) handlers.onStderr?.(chunk);
    return this.exitCode;
  }
}
