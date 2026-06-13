// Injectable child-process runner.
//
// Every harness that drives a native CLI (`claude`, `codex`, `pi`) goes
// through this module rather than calling `node:child_process` directly,
// so tests can stub the runner and assert the exact command + args a
// harness invokes — WITHOUT spawning real processes or touching PATH.
//
// Security (spec §9): a command may *carry* the agent token (e.g. via an
// env var its native mechanism reads), but the token is NEVER logged,
// echoed, or placed where this module would print it. The runner returns
// stdout/stderr to the caller; it deliberately does not log them.
//
// Stubbing: `setRunner()` swaps the module-level default for a fake in
// tests; `resetRunner()` restores the real one. `run`/`which` always go
// through the current runner, so a single override covers both.

import { spawn } from "node:child_process";

/** The result of running a command: captured streams + exit code. */
export interface RunResult {
  stdout: string;
  stderr: string;
  /** The process exit code; `null` only if the process was signalled. */
  code: number | null;
}

/** Options for a single command run. */
export interface RunOptions {
  /**
   * Extra environment for the child. Merged over `process.env`. The token
   * rides here (per a harness's native env-var mechanism) — it is passed
   * to the child but never logged by this module.
   */
  env?: Record<string, string | undefined> | undefined;
  /** Working directory for the child. */
  cwd?: string | undefined;
}

/**
 * The runner surface every harness depends on. The default implementation
 * spawns real processes; tests inject a fake that records calls.
 */
export interface Runner {
  /** Run `cmd args…`, resolving with captured streams + exit code. */
  run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
  /** Resolve `cmd` to its absolute path on PATH, or `null` if absent. */
  which(cmd: string): Promise<string | null>;
}

// --- the real, process-spawning runner -----------------------------------

const realRunner: Runner = {
  run(cmd, args, opts = {}) {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // ENOENT (binary not on PATH) surfaces here, not as a non-zero exit.
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ stdout, stderr, code });
      });
    });
  },

  async which(cmd) {
    // Use the platform's own resolver so PATHEXT etc. are honoured. A
    // non-zero exit (not found) resolves to null; we never throw.
    const probe = process.platform === "win32" ? "where" : "which";
    try {
      const { stdout, code } = await realRunner.run(probe, [cmd]);
      if (code !== 0) return null;
      const first = stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      return first ?? null;
    } catch {
      // `which`/`where` itself missing, or some other spawn failure.
      return null;
    }
  },
};

// --- the swappable module-level runner -----------------------------------

let current: Runner = realRunner;

/** Run a command through the current runner. */
export function run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult> {
  return current.run(cmd, args, opts);
}

/** Resolve a command to its PATH location through the current runner. */
export function which(cmd: string): Promise<string | null> {
  return current.which(cmd);
}

/** Swap in a fake runner (tests). Returns the previous runner. */
export function setRunner(runner: Runner): Runner {
  const prev = current;
  current = runner;
  return prev;
}

/** Restore the real, process-spawning runner (tests). */
export function resetRunner(): void {
  current = realRunner;
}
