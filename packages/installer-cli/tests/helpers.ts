// Test helpers: a throwaway HOME dir so nothing touches the real
// `~/.librarian`. Every test gets its own temp dir, removed after.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOptions, RunResult, Runner } from "../src/exec.js";

/** Run `fn` with a fresh temp home dir, cleaned up afterwards. */
export async function withTempHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-cli-test-"));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
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
