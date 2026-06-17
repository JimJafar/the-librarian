// Codex hook ENTRY shell — the user-protecting exit-code contract.
// Spec 2026-06-16-harness-auto-capture, Phase 2A. Mirrors
// test/claude-hook-entries.test.ts for the Codex capture entry.
//
// The entry under integrations/codex/scripts/on-stop.mjs is a THIN shell over the
// pure lib (integrations/codex/scripts/lib/*.mjs). Its CONTRACT is an exit code:
// it must NEVER block the user's turn, never exit non-zero, never leak a stack
// trace to stdout/stderr. That contract is the REAL process exit, so these tests
// SPAWN `node <entry>` with piped stdin and assert the exit code + output, exactly
// as Codex invokes a command hook.
//
//   - malformed JSON / no stdin → exit 0 (fail-soft no-op).
//   - a valid hook with no config (nowhere to ship) → exit 0 (clean no-op).
//   - a HELD-OPEN stdin (the harness never closes the pipe) still exits within the
//     entry's internal stdin-read timeout — fail-soft must not depend on the
//     harness closing the pipe.

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ON_STOP = path.join(REPO_ROOT, "integrations", "codex", "scripts", "on-stop.mjs");

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

// An isolated plugin-data + HOME dir per test so a spawned entry's sidecar log
// lands in a temp dir and NEVER pollutes the repo working tree.
let tmpDataDir = "";
beforeEach(() => {
  tmpDataDir = makeTempDir();
});
afterEach(() => {
  if (tmpDataDir) cleanupTempDir(tmpDataDir);
  tmpDataDir = "";
});

/**
 * Spawn `node <entry>`, write `stdin` (then END the pipe), resolve the exit code +
 * output. We do NOT inherit process.env beyond PATH so a developer's real
 * LIBRARIAN_* config can't make a capture test reach the network; HOME +
 * CODEX_PLUGIN_DATA are pinned to the per-test temp dir.
 */
function runEntry(
  entry: string,
  { stdin = "", env = {} }: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpDataDir,
        CODEX_PLUGIN_DATA: tmpDataDir,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.stdin.on("error", () => {}); // a fast exit can EPIPE the stdin write — ignore
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Spawn an entry but HOLD stdin open (never call `.end()`), to prove the entry's
 * internal stdin-read timeout fires and the process still exits without the
 * harness closing the pipe.
 */
function runEntryHeldOpenStdin(
  entry: string,
  { env = {}, deadlineMs = 8000 }: { env?: Record<string, string>; deadlineMs?: number } = {},
): Promise<RunResult & { ms: number; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child: ChildProcess = spawn(process.execPath, [entry], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpDataDir,
        CODEX_PLUGIN_DATA: tmpDataDir,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.stdin?.on("error", () => {});
    child.stdin?.write(""); // write a byte but NEVER end the pipe (held-open case)
    const guard = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.on("error", (e) => {
      clearTimeout(guard);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, killed });
    });
  });
}

describe("codex on-stop.mjs entry: fail-soft exit-0 contract", () => {
  it("exits 0 on MALFORMED hook JSON (never breaks the user's turn)", async () => {
    const r = await runEntry(ON_STOP, { stdin: "{not json at all" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(""); // nothing leaks to the model
  });

  it("exits 0 with NO stdin at all (empty input → no-op)", async () => {
    const r = await runEntry(ON_STOP, { stdin: "" });
    expect(r.code).toBe(0);
  });

  it("exits 0 on a valid hook with no config (nowhere to ship → clean no-op)", async () => {
    const r = await runEntry(ON_STOP, {
      stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "run-1" }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("exits 0 on a valid hook with no stable conv_id (cwd-only → no-op, never cwd-keyed)", async () => {
    const r = await runEntry(ON_STOP, {
      stdin: JSON.stringify({ hook_event_name: "Stop", cwd: "/home/u/proj" }),
    });
    expect(r.code).toBe(0);
  });
});

describe("codex on-stop.mjs entry does not hang on a held-open stdin", () => {
  it("exits within its internal stdin timeout even if the pipe never closes", async () => {
    const r = await runEntryHeldOpenStdin(ON_STOP);
    expect(r.killed, "process had to be force-killed → it hung on stdin").toBe(false);
    expect(r.code).toBe(0); // fail-soft no-op
  });
});
