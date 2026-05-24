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
  return { done, kill: (signal) => proc.kill(signal) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("docker/supervisor.mjs", () => {
  it("starts both children and exits 0 when sent SIGTERM", async () => {
    const sup = runSupervisor([longChild("a"), longChild("b")]);
    await wait(600); // let both children start
    sup.kill("SIGTERM");
    const result = await sup.done;
    expect(result.stdout).toContain("STARTED:a");
    expect(result.stdout).toContain("STARTED:b");
    expect(result.code).toBe(0);
  });

  it("crash-fasts (non-zero) and kills the sibling when one child exits unexpectedly", async () => {
    // The crasher exits 1 immediately; if the supervisor did NOT kill the
    // long-running sibling, this promise would hang until the test timeout.
    const sup = runSupervisor([crashChild("crasher", 1), longChild("sibling")]);
    const result = await sup.done;
    expect(result.code).not.toBe(0);
  }, 10_000);

  it("never writes to its own stdout beyond child output (no banner noise)", async () => {
    // The supervisor itself should be quiet; only child output (STARTED:*) appears.
    const sup = runSupervisor([longChild("only")]);
    await wait(400);
    sup.kill("SIGTERM");
    const result = await sup.done;
    const nonChildLines = result.stdout
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("STARTED:"));
    expect(nonChildLines).toEqual([]);
  });
});
