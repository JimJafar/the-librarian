// Injectable `docker` / `git` runner for the `server` command group.
//
// Every `server` subcommand (up / update / down / status / logs / boot /
// admin) drives the host's `docker` and `git` binaries. They go through THIS
// seam rather than `node:child_process` directly, so tests stub the runner and
// assert the exact argv each command invokes — WITHOUT spawning a real process
// or touching a real Docker daemon.
//
// This mirrors `src/exec.ts` (the harness CLI runner) deliberately: same
// `Runner` shape, same `run`/`which`/`setRunner`/`resetRunner` surface. It is a
// SEPARATE module-level runner, though — the harness commands and the server
// commands inject independently, so a test that stubs one never disturbs the
// other. Reusing `exec.ts`'s `Runner`/`RunResult`/`RunOptions` types keeps a
// single fake (`FakeRunner`) usable for both.
//
// Security (AGENTS.md): a command may *carry* a bearer token via an env var its
// native mechanism reads, but this module never logs, echoes, or persists the
// streams it returns.

import { spawn } from "node:child_process";
import type { RunOptions, RunResult, Runner } from "../exec.js";

export type { RunOptions, RunResult, Runner } from "../exec.js";

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
      return null;
    }
  },
};

// --- the swappable module-level runner -----------------------------------

let current: Runner = realRunner;

/** Run a command (`docker`/`git`) through the current server runner. */
export function run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult> {
  return current.run(cmd, args, opts);
}

/** Resolve a command to its PATH location through the current server runner. */
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
