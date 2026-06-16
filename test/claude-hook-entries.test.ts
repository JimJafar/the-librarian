// Claude hook ENTRY shells — the user-protecting exit-code contract (spec
// 2026-06-16-harness-auto-capture, FIX S2 + I2).
//
// The entries under integrations/claude/scripts/*.mjs are thin shells over the
// pure lib. Their CONTRACT is an exit code + (for the write-block) a stderr the
// harness reads. That contract is what protects the user's turn — it cannot be
// asserted by importing the pure modules; it has to be the REAL process exit. So
// these tests SPAWN `node <entry>` with piped stdin and assert the exit code and
// output, exactly as Claude Code invokes them.
//
//   - on-stop.mjs (Stop/SessionEnd capture): malformed JSON / no stdin → exit 0
//     (fail-soft no-op; it must never block the user's turn).
//   - block-memory-write.mjs (PreToolUse write guard): a native-store path → exit
//     2 + a stderr naming `remember`; an ordinary path / malformed input → exit 0
//     (fail-OPEN — a guard bug must never block a legitimate write).
//   - on-session-start.mjs (SessionStart banner): no env → exit 0 + emits the
//     awareness line (capture probe fails soft to awareness-only).
//   - I2 (no-hang): a HELD-OPEN stdin (the harness never closes the pipe) still
//     exits within the entry's internal stdin-read timeout — fail-soft/fail-open
//     must not depend on the harness closing the pipe.

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(REPO_ROOT, "integrations", "claude", "scripts");
const ON_STOP = path.join(SCRIPTS, "on-stop.mjs");
const BLOCK_WRITE = path.join(SCRIPTS, "block-memory-write.mjs");
const ON_SESSION_START = path.join(SCRIPTS, "on-session-start.mjs");

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

// An isolated plugin-data + HOME dir per test so a spawned entry's sidecar log
// (on-stop writes capture.log under CLAUDE_PLUGIN_DATA / $HOME) lands in a temp
// dir and NEVER pollutes the repo working tree.
let tmpDataDir = "";
beforeEach(() => {
  tmpDataDir = makeTempDir();
});
afterEach(() => {
  if (tmpDataDir) cleanupTempDir(tmpDataDir);
  tmpDataDir = "";
});

/**
 * Spawn `node <entry>`, write `stdin` (then END the pipe), and resolve the exit
 * code + captured output. `env` is the FULL child env (we deliberately do NOT
 * inherit process.env beyond PATH so a developer's real LIBRARIAN_* config can't
 * make a capture/banner test reach the network). The plugin-data dir + HOME are
 * pinned to the per-test temp dir so any sidecar write is isolated.
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
        CLAUDE_PLUGIN_DATA: tmpDataDir,
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
 * internal stdin-read timeout (I2) fires and the process still exits without the
 * harness closing the pipe. Returns the result + how long it took; the test fails
 * if the child has to be force-killed at the deadline.
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
        CLAUDE_PLUGIN_DATA: tmpDataDir,
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
    // Write a byte but NEVER end the pipe — stdin stays open (the held-open case).
    child.stdin?.write("");
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

// ── on-stop.mjs — Stop/SessionEnd capture entry (fail-soft, exit 0) ──────────

describe("on-stop.mjs entry: fail-soft exit-0 contract (S2)", () => {
  it("exits 0 on MALFORMED hook JSON (never breaks the user's turn)", async () => {
    const r = await runEntry(ON_STOP, { stdin: "{not json at all" });
    expect(r.code).toBe(0);
    // No stack trace / nothing leaks to the model on the happy/error path.
    expect(r.stdout).toBe("");
  });

  it("exits 0 with NO stdin at all (empty input → no-op)", async () => {
    const r = await runEntry(ON_STOP, { stdin: "" });
    expect(r.code).toBe(0);
  });

  it("exits 0 on a valid hook with no config (nowhere to ship → clean no-op)", async () => {
    // A well-formed Stop but no LIBRARIAN_MCP_URL/token: runCapture skips,
    // fail-soft, exit 0.
    const r = await runEntry(ON_STOP, {
      stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }),
    });
    expect(r.code).toBe(0);
  });
});

// ── block-memory-write.mjs — PreToolUse write guard (exit 2 block / 0 open) ──

describe("block-memory-write.mjs entry: block/allow exit contract (S2)", () => {
  it("exits 2 and names `remember` on a NATIVE Claude memory-store write", async () => {
    const r = await runEntry(BLOCK_WRITE, {
      stdin: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/home/u/project/.claude/agents/memory/MEMORY.md" },
      }),
    });
    expect(r.code).toBe(2); // Claude reads exit 2 as DENY
    expect(r.stderr).toContain("remember"); // the teaching redirect
  });

  it("exits 0 (fail-OPEN) on an ORDINARY file path (a legitimate write is never blocked)", async () => {
    const r = await runEntry(BLOCK_WRITE, {
      stdin: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/home/u/project/src/index.ts" },
      }),
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 (fail-OPEN) on MALFORMED stdin (a guard bug must not block a write)", async () => {
    const r = await runEntry(BLOCK_WRITE, { stdin: "}{ broken" });
    expect(r.code).toBe(0);
  });
});

// ── on-session-start.mjs — SessionStart banner (exit 0 + awareness line) ─────

describe("on-session-start.mjs entry: awareness banner exit contract (S2)", () => {
  it("exits 0 with NO env and still emits the awareness line", async () => {
    const r = await runEntry(ON_SESSION_START, { stdin: "", env: {} });
    expect(r.code).toBe(0);
    // The static awareness half is always present (it survives compaction).
    expect(r.stdout).toContain("recall");
    expect(r.stdout).toContain("remember");
    expect(r.stdout).toContain("The Librarian");
  });
});

// ── I2 — held-open stdin must not hang on the harness ────────────────────────

describe("hook entries do not hang on a held-open stdin (I2)", () => {
  it("on-stop.mjs exits within its internal stdin timeout even if the pipe never closes", async () => {
    const r = await runEntryHeldOpenStdin(ON_STOP);
    expect(r.killed, "process had to be force-killed → it hung on stdin").toBe(false);
    expect(r.code).toBe(0); // fail-soft no-op
  });

  it("block-memory-write.mjs exits within its internal stdin timeout (fail-OPEN, not a timeout-DENY)", async () => {
    const r = await runEntryHeldOpenStdin(BLOCK_WRITE);
    expect(r.killed, "process had to be force-killed → it hung on stdin").toBe(false);
    // CRITICAL: a held-open write-block stdin must fail OPEN (exit 0), never read
    // as a DENY (exit 2) — a timeout must not block a legitimate write.
    expect(r.code).toBe(0);
  });
});
