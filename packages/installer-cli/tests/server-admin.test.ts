// S7a — `librarian server admin <verb> [args…]`: dispatch a curated subset of
// the folded-in `@librarian/cli` (`the-librarian`) into the running container.
//
// The load-bearing assertions (spec §7):
//   - The argv is EXACTLY `docker exec the-librarian the-librarian <verb> [args…]`
//     with the remaining args passed through VERBATIM, in order.
//   - Only `backup | restore | auth | rebuild` are exposed; anything else
//     (`seed`, `migrate-data-dir`, `export`, `handoffs`, or a typo) is a teaching
//     error that names the allowed verbs and runs NO `docker exec`.
//   - Preflight runs first; a container that isn't running is a teaching error
//     ("the server isn't running — `librarian server up` first") with NO exec.

import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import { FakeRunner, withTempHome } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
});

/** A runner with docker present, daemon reachable, and the container running. */
function adminReady(): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("git")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
      stdout: "running\n",
      code: 0,
    });
}

/** The `docker exec` calls the runner recorded, in order (verb + passthrough). */
function execCalls(runner: FakeRunner): string[][] {
  return runner.calls.filter((c) => c.cmd === "docker" && c.args[0] === "exec").map((c) => c.args);
}

describe("server admin — dispatches the curated verbs into the container", () => {
  it("`backup` → docker exec the-librarian the-librarian backup", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "backup"], { home, interactive: false });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([["exec", "the-librarian", "the-librarian", "backup"]]);
    });
  });

  it("`auth reset-password --user x` passes the sub-verb + args through VERBATIM, in order", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "auth", "reset-password", "--user", "x"], {
        home,
        interactive: false,
      });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([
        ["exec", "the-librarian", "the-librarian", "auth", "reset-password", "--user", "x"],
      ]);
    });
  });

  it("`rebuild` → docker exec the-librarian the-librarian rebuild", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "rebuild"], { home, interactive: false });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([["exec", "the-librarian", "the-librarian", "rebuild"]]);
    });
  });

  it("`restore --secret-key …` passes the flag + value through VERBATIM", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "restore", "--secret-key", "abc123"], {
        home,
        interactive: false,
      });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([
        ["exec", "the-librarian", "the-librarian", "restore", "--secret-key", "abc123"],
      ]);
    });
  });

  it("an interactive run adds `-it` so prompts (e.g. restore's secret-key) work", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "restore"], { home, interactive: true });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([
        ["exec", "-it", "the-librarian", "the-librarian", "restore"],
      ]);
    });
  });
});

describe("server admin — only the curated verbs are exposed (spec §7)", () => {
  it("`seed` is NOT folded in → teaching error, NO docker exec", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "seed"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      // Names the allowed verbs so the reader knows what IS available.
      expect(r.stderr).toMatch(/backup/);
      expect(r.stderr).toMatch(/restore/);
      expect(r.stderr).toMatch(/auth/);
      expect(r.stderr).toMatch(/rebuild/);
      // Mentions the rejected verb so the error is specific.
      expect(r.stderr).toMatch(/seed/);
      // NOTHING was exec'd into the container.
      expect(execCalls(runner)).toEqual([]);
      // No stack trace leaked.
      expect(r.stderr).not.toMatch(/at \w+.*\(/);
    });
  });

  it("an unknown verb (`frobnicate`) → teaching error naming the allowed verbs, NO exec", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "frobnicate"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/backup.*restore.*auth.*rebuild|backup|restore|auth|rebuild/);
      expect(execCalls(runner)).toEqual([]);
    });
  });

  it("no verb at all → teaching error naming the allowed verbs, NO exec", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/backup/);
      expect(execCalls(runner)).toEqual([]);
    });
  });
});

describe("server admin — preflight + container-running guards", () => {
  it("docker missing → teaching error, NO exec", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner(); // nothing on PATH
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "backup"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/docker/i);
      expect(r.stderr).toMatch(/install/i);
      expect(execCalls(runner)).toEqual([]);
    });
  });

  it("container not running → teaching error pointing at `server up`, NO exec", async () => {
    await withTempHome(async (home) => {
      // docker + daemon fine, but `inspect` reports the container is absent.
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
          stderr: "Error: No such object: the-librarian\n",
          code: 1,
        });
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "backup"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/not running|isn't running|is not running/i);
      expect(r.stderr).toMatch(/server up/);
      expect(execCalls(runner)).toEqual([]);
      // No stack trace leaked.
      expect(r.stderr).not.toMatch(/at \w+.*\(/);
    });
  });
});
