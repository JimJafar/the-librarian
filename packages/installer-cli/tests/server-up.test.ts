// S2 — `librarian server up` (localhost happy path).
//
// Every test drives the public `runCli(["server", "up", …])` entry against a
// fresh temp home, the injected `docker.ts` FakeRunner (so the EXACT git/docker
// argv is asserted), a stubbed latest-release fetcher, a deterministic agent
// token, a no-op health-poll sleep, and a scripted prompter. No real daemon,
// network, or git is ever touched.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvFile } from "../src/env.js";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import {
  buildRunArgs,
  resetSleep,
  resetTokenMinter,
  setSleep,
  setTokenMinter,
} from "../src/server/up.js";
import { resetLatestFetcher, setLatestFetcher } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";
import { FakePrompter } from "./prompter.js";

const AGENT_TOKEN = "agent-token-deterministic-for-tests";
const MASTER_KEY = "master-key-read-back-from-the-container-once";
const LATEST = "1.4.2"; // fetchLatestVersion returns the v-stripped version
const LATEST_TAG = "v1.4.2";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetLatestFetcher();
  resetSleep();
  resetTokenMinter();
});

/** A FakeRunner wired for a fully-successful localhost `up`. */
function healthyRunner(): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("git")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
      stdout: "healthy\n",
      code: 0,
    })
    .onRun("docker", ["exec", "the-librarian", "cat", "/data/secret.key"], {
      stdout: `${MASTER_KEY}\n`,
      code: 0,
    });
}

/** Install the deterministic seams shared by the happy-path tests. */
function stubSeams(): void {
  setLatestFetcher(async () => LATEST);
  setTokenMinter(() => AGENT_TOKEN);
  setSleep(async () => undefined);
}

/** The argv (after `docker`) any `run -d …` call recorded by the runner. */
function dockerRunArgs(runner: FakeRunner): string[] | undefined {
  return runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "run")?.args;
}

describe("server up — fresh localhost happy path (exact argv)", () => {
  it("clones at the latest tag, builds, then runs the localhost container", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);

      const deployDir = path.join(home, ".librarian", "server");

      // git clone <repo> <dir>, then checkout the resolved tag.
      expect(
        runner.ran("git", ["clone", "https://github.com/JimJafar/the-librarian", deployDir]),
      ).toBe(true);
      expect(runner.ran("git", ["-C", deployDir, "checkout", LATEST_TAG])).toBe(true);

      // docker build with the VERIFIED command.
      expect(
        runner.ran("docker", [
          "build",
          "-f",
          "docker/all-in-one.Dockerfile",
          "-t",
          `the-librarian:${LATEST_TAG}`,
          ".",
        ]),
      ).toBe(true);

      // docker run — the EXACT localhost argv (ALLOW_NO_AUTH present, no --init).
      expect(dockerRunArgs(runner)).toEqual([
        "run",
        "-d",
        "--name",
        "the-librarian",
        "--restart",
        "unless-stopped",
        "-p",
        "127.0.0.1:3000:3000",
        "-p",
        "127.0.0.1:3838:3838",
        "-v",
        "librarian_data:/data",
        "-e",
        `LIBRARIAN_AGENT_TOKEN=${AGENT_TOKEN}`,
        "-e",
        "LIBRARIAN_ALLOW_NO_AUTH=true",
        `the-librarian:${LATEST_TAG}`,
      ]);
    });
  });

  it("runs build + run from the deploy dir (cwd carries the Dockerfile context)", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      await runCli(["server", "up"], { home, prompter });

      const deployDir = path.join(home, ".librarian", "server");
      const build = runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "build");
      const dRun = runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
      expect(build?.opts?.cwd).toBe(deployDir);
      expect(dRun?.opts?.cwd).toBe(deployDir);
    });
  });
});

describe("server up — flags reflected in argv", () => {
  it("--data-volume, --dir and --ref are honoured", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const customDir = path.join(home, "custom-deploy");
      const r = await runCli(
        ["server", "up", "--data-volume", "my_vol", "--dir", customDir, "--ref", "main"],
        { home, prompter },
      );
      expect(r.exitCode).toBe(0);

      // Clone + checkout at the pinned ref, into the custom dir.
      expect(
        runner.ran("git", ["clone", "https://github.com/JimJafar/the-librarian", customDir]),
      ).toBe(true);
      expect(runner.ran("git", ["-C", customDir, "checkout", "main"])).toBe(true);

      // The image tag follows the ref; the volume is the override.
      expect(
        runner.ran("docker", [
          "build",
          "-f",
          "docker/all-in-one.Dockerfile",
          "-t",
          "the-librarian:main",
          ".",
        ]),
      ).toBe(true);
      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("my_vol:/data");
      expect(runArgs?.[runArgs.length - 1]).toBe("the-librarian:main");
    });
  });
});

describe("server up — health-wait failure rolls back (no half-up)", () => {
  it("an unhealthy container is removed, logs surfaced, and the command errors", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
          stdout: "unhealthy\n",
          code: 0,
        })
        .onRun("docker", ["logs", "--tail", "50", "the-librarian"], {
          stdout: "boom: the server crashed on boot\n",
          code: 0,
        });
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      // The container reports `unhealthy`, so the poll terminates fast (no need
      // to wait out the bound) and the flow rolls back.
      const r = await runCli(["server", "up"], { home, prompter });

      expect(r.exitCode).toBe(1);
      // Rolled back — the container was force-removed.
      expect(runner.ran("docker", ["rm", "-f", "the-librarian"])).toBe(true);
      // Logs were surfaced to the operator.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "logs")).toBe(true);
      expect(r.stderr).toMatch(/did not become healthy/i);
      expect(r.stderr).toMatch(/rolled back/i);
      // No master-key read happened (we failed before the exec).
      expect(runner.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(
        false,
      );
    });
  });
});

describe("server up — master key surfaced once, persisted nowhere", () => {
  it("prints the key exactly once with the SAVE warning and writes it to no file", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      // Accept the env-write offer — even then, the MASTER KEY must not land in
      // any file (only the agent token may).
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "y" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);

      // Surfaced exactly once, beside the SAVE warning.
      expect(r.stdout).toContain(MASTER_KEY);
      expect(r.stdout.split(MASTER_KEY).length - 1).toBe(1);
      expect(r.stdout).toMatch(/SAVE THIS KEY — excluded from backups/);

      // The master key appears in NO file under the home / deploy tree.
      const filesWithKey = filesContaining(home, MASTER_KEY);
      expect(filesWithKey).toEqual([]);
    });
  });
});

describe("server up — foreign deploy dir stops and asks (never clobbers)", () => {
  it("a git repo with a different remote halts before any clobbering git op", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      fs.mkdirSync(path.join(deployDir, ".git"), { recursive: true });

      const runner = healthyRunner().onRun(
        "git",
        ["-C", deployDir, "remote", "get-url", "origin"],
        { stdout: "https://github.com/someone-else/other-repo.git\n", code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/different remote/i);

      // It must NOT have clobbered: no clone, no fetch, no checkout.
      expect(runner.calls.some((c) => c.cmd === "git" && c.args[0] === "clone")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "git" && c.args.includes("checkout"))).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "git" && c.args.includes("fetch"))).toBe(false);
      // And it never reached docker build/run.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
    });
  });

  it("our managed clone fetches + checks out the ref (does not re-clone)", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      fs.mkdirSync(path.join(deployDir, ".git"), { recursive: true });

      const runner = healthyRunner().onRun(
        "git",
        ["-C", deployDir, "remote", "get-url", "origin"],
        { stdout: "git@github.com:JimJafar/the-librarian.git\n", code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);

      // No clone (already ours); fetch tags + checkout the resolved tag.
      expect(runner.calls.some((c) => c.cmd === "git" && c.args[0] === "clone")).toBe(false);
      expect(runner.ran("git", ["-C", deployDir, "fetch", "--tags", "origin"])).toBe(true);
      expect(runner.ran("git", ["-C", deployDir, "checkout", LATEST_TAG])).toBe(true);
    });
  });
});

describe("server up — loop-closer (MCP URL + token + env offer)", () => {
  it("prints the MCP/dashboard URLs + agent token; writes env only when accepted", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "y" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);

      expect(r.stdout).toContain("http://127.0.0.1:3838/mcp");
      expect(r.stdout).toContain("http://127.0.0.1:3000");
      expect(r.stdout).toContain(AGENT_TOKEN);

      // Accepted → env written with the URL + agent token (the agent token MAY
      // be persisted; the master key may not).
      const env = readEnvFile(home);
      expect(env?.mcpUrl).toBe("http://127.0.0.1:3838/mcp");
      expect(env?.token).toBe(AGENT_TOKEN);
    });
  });

  it("declined offer leaves ~/.librarian/env unwritten", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);
      expect(readEnvFile(home)).toBeNull();
    });
  });

  it("--yes auto-accepts the env write without prompting", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      // A prompter that THROWS if asked — proves --yes never prompts.
      const prompter = new FakePrompter({});

      const r = await runCli(["server", "up", "--yes"], { home, prompter });
      expect(r.exitCode).toBe(0);
      expect(readEnvFile(home)?.token).toBe(AGENT_TOKEN);
      expect(prompter.textCalls.length).toBe(0);
    });
  });
});

describe("server up — beyond-localhost binding is deferred (S3)", () => {
  it("--host beyond 127.0.0.1 stops with a clear not-yet message", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", "0.0.0.0"], { home, prompter });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/localhost path only/i);
      // Stopped before any git/docker work.
      expect(runner.calls.some((c) => c.cmd === "git")).toBe(false);
    });
  });
});

describe("buildRunArgs — the S3 seam", () => {
  it("localhost includes ALLOW_NO_AUTH and omits --init", () => {
    const args = buildRunArgs({
      host: "127.0.0.1",
      dataVolume: "librarian_data",
      tag: "v1.0.0",
      agentToken: "tok",
    });
    expect(args).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    expect(args).not.toContain("--init");
    expect(args[args.length - 1]).toBe("the-librarian:v1.0.0");
  });
});

// --- helpers -------------------------------------------------------------

/** Recursively collect files under `dir` whose contents contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        let content = "";
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (content.includes(needle)) hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
}
