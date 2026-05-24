import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The single-container image runs both services under docker/supervisor.mjs as
// PID 1. These spawn the real supervisor with FAKE children (via the
// LIBRARIAN_SUPERVISOR_CHILDREN override) and assert the two invariants that make
// it safe as PID 1: clean signal forwarding (SIGTERM → both stop → exit 0) and
// crash-fast (a child dying takes the whole container down non-zero, so the
// orchestrator restarts the pair rather than limping on half-up).
const supervisor = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docker",
  "supervisor.mjs",
);

interface Child {
  name: string;
  cmd: string;
  args: string[];
}

function longChild(name: string): Child {
  // Print a start marker, then run until killed.
  return {
    name,
    cmd: process.execPath,
    args: ["-e", `console.log("STARTED:${name}");setInterval(() => {}, 1e9);`],
  };
}

function crashChild(name: string, code: number): Child {
  return { name, cmd: process.execPath, args: ["-e", `process.exit(${code});`] };
}

function runSupervisor(children: Child[]): {
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>;
  kill: (signal: NodeJS.Signals) => void;
  waitForStdout: (needle: string, timeoutMs?: number) => Promise<void>;
} {
  const proc = spawn(process.execPath, [supervisor], {
    env: { ...process.env, LIBRARIAN_SUPERVISOR_CHILDREN: JSON.stringify(children) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  proc.stdout.on("data", (d) => (stdout += d));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>(
    (resolve) => {
      proc.on("close", (code, signal) => resolve({ code, signal, stdout }));
    },
  );
  // Resolve as soon as `needle` appears in stdout — deterministic, no fixed sleep.
  function waitForStdout(needle: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = setInterval(() => {
        if (stdout.includes(needle)) {
          clearInterval(tick);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(tick);
          reject(new Error(`timed out waiting for "${needle}"; saw: ${JSON.stringify(stdout)}`));
        }
      }, 20);
    });
  }
  return { done, kill: (signal) => proc.kill(signal), waitForStdout };
}

describe("docker/supervisor.mjs", () => {
  it("starts both children and exits 0 when sent SIGTERM", async () => {
    const sup = runSupervisor([longChild("a"), longChild("b")]);
    await sup.waitForStdout("STARTED:a");
    await sup.waitForStdout("STARTED:b");
    sup.kill("SIGTERM");
    const result = await sup.done;
    expect(result.code).toBe(0);
  });

  it("exits 0 on SIGINT too", async () => {
    const sup = runSupervisor([longChild("a"), longChild("b")]);
    await sup.waitForStdout("STARTED:b");
    sup.kill("SIGINT");
    const result = await sup.done;
    expect(result.code).toBe(0);
  });

  it("crash-fasts (non-zero) and kills the sibling when one child exits unexpectedly", async () => {
    // The crasher exits 1 immediately; if the supervisor did NOT kill the
    // long-running sibling, this promise would hang until the test timeout.
    const sup = runSupervisor([crashChild("crasher", 1), longChild("sibling")]);
    const result = await sup.done;
    expect(result.code).not.toBe(0);
  }, 10_000);

  it("treats a child exiting 0 on its own as a failure (all-or-nothing container)", async () => {
    const sup = runSupervisor([crashChild("quitter", 0), longChild("sibling")]);
    const result = await sup.done;
    expect(result.code).not.toBe(0);
  }, 10_000);

  it("never writes to its own stdout beyond child output (no banner noise)", async () => {
    const sup = runSupervisor([longChild("only")]);
    await sup.waitForStdout("STARTED:only");
    sup.kill("SIGTERM");
    const result = await sup.done;
    const nonChildLines = result.stdout
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("STARTED:"));
    expect(nonChildLines).toEqual([]);
  });
});
