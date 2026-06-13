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

describe("server up — beyond-localhost binding (S3)", () => {
  const TAILNET = "100.101.102.103";
  const ADMIN_TOKEN = "admin-token-read-back-from-the-container-once";

  /** A FakeRunner wired for a fully-successful beyond-localhost `up`. */
  function beyondRunner(): FakeRunner {
    return healthyRunner().onRun("docker", ["exec", "the-librarian", "cat", "/data/admin.token"], {
      stdout: `${ADMIN_TOKEN}\n`,
      code: 0,
    });
  }

  it("--host <tailnet-ip>: omits ALLOW_NO_AUTH, binds the tailnet IP, reads + surfaces the admin token once, MCP URL uses the host", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", TAILNET], { home, prompter });
      expect(r.exitCode).toBe(0);

      // docker run argv: OMITS ALLOW_NO_AUTH, publishes on the tailnet IP.
      const runArgs = dockerRunArgs(runner);
      expect(runArgs).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(runArgs).toContain(`${TAILNET}:3000:3000`);
      expect(runArgs).toContain(`${TAILNET}:3838:3838`);

      // After health, the admin token is read from the container...
      expect(runner.ran("docker", ["exec", "the-librarian", "cat", "/data/admin.token"])).toBe(
        true,
      );
      // ...and surfaced exactly once.
      expect(r.stdout).toContain(ADMIN_TOKEN);
      expect(r.stdout.split(ADMIN_TOKEN).length - 1).toBe(1);

      // The MCP URL uses the chosen host.
      expect(r.stdout).toContain(`http://${TAILNET}:3838/mcp`);
      expect(r.stdout).toContain(`http://${TAILNET}:3000`);
    });
  });

  it("argv DIFF (SC 3): localhost reads only secret.key; beyond-localhost omits ALLOW_NO_AUTH and reads BOTH secret.key + admin.token", async () => {
    await withTempHome(async (home) => {
      // --- localhost run ---
      const local = healthyRunner();
      setDockerRunner(local);
      stubSeams();
      const lr = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });
      expect(lr.exitCode).toBe(0);

      const localRun = dockerRunArgs(local);
      expect(localRun).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      // Reads ONLY the master key — no admin.token read on localhost.
      expect(local.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(true);
      expect(local.ran("docker", ["exec", "the-librarian", "cat", "/data/admin.token"])).toBe(
        false,
      );
      resetDockerRunner();
    });

    await withTempHome(async (home) => {
      // --- beyond-localhost run ---
      const beyond = beyondRunner();
      setDockerRunner(beyond);
      stubSeams();
      const br = await runCli(["server", "up", "--host", TAILNET], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });
      expect(br.exitCode).toBe(0);

      const beyondRun = dockerRunArgs(beyond);
      expect(beyondRun).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      // Reads BOTH the master key AND the admin token.
      expect(beyond.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(true);
      expect(beyond.ran("docker", ["exec", "the-librarian", "cat", "/data/admin.token"])).toBe(
        true,
      );
    });
  });

  it("the admin token (and master key) appear in stdout once and in NO file under the home/deploy tree", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      // Accept the env-write offer — even then, neither secret may land in a file.
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "y" } });

      const r = await runCli(["server", "up", "--host", TAILNET, "--yes"], { home, prompter });
      expect(r.exitCode).toBe(0);

      expect(r.stdout.split(ADMIN_TOKEN).length - 1).toBe(1);
      expect(r.stdout.split(MASTER_KEY).length - 1).toBe(1);

      expect(filesContaining(home, ADMIN_TOKEN)).toEqual([]);
      expect(filesContaining(home, MASTER_KEY)).toEqual([]);
    });
  });

  it("--host 0.0.0.0 WITHOUT --yes prompts; declining aborts before docker run", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      // The confirm prompt is keyed on "0.0.0.0"; answer "n" to decline.
      const prompter = new FakePrompter({ answers: { "0.0.0.0": "n" } });

      const r = await runCli(["server", "up", "--host", "0.0.0.0"], { home, prompter });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/all interfaces|0\.0\.0\.0|aborted|declin/i);

      // Aborted before any docker run (and before git work).
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(false);
      // The confirm was actually asked.
      expect(prompter.textCalls.some((c) => c.question.includes("0.0.0.0"))).toBe(true);
    });
  });

  it("--host 0.0.0.0 with --yes proceeds (no confirm prompt) and prints the unreachable-address note", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      // A prompter that THROWS if the 0.0.0.0 confirm is asked — proves --yes skips it.
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", "0.0.0.0", "--yes"], { home, prompter });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("0.0.0.0:3838:3838");
      expect(runArgs).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      // 0.0.0.0 is a bind, not a connectable address — a one-line note tells the user.
      expect(r.stdout).toMatch(/reachable|LAN|tailnet|not a connectable/i);
      // No 0.0.0.0 confirm prompt happened under --yes.
      expect(prompter.textCalls.some((c) => c.question.includes("0.0.0.0"))).toBe(false);
    });
  });
});

describe("server up — Tailscale best-effort offer (S3)", () => {
  const TAILNET = "100.64.0.7";

  /** A healthy runner that ALSO reads back the admin token (beyond-localhost). */
  function tsRunner(): FakeRunner {
    return healthyRunner()
      .withWhich("tailscale")
      .onRun("tailscale", ["ip", "-4"], { stdout: `${TAILNET}\n`, code: 0 })
      .onRun("docker", ["exec", "the-librarian", "cat", "/data/admin.token"], {
        stdout: "admin-token-from-tailscale-offer\n",
        code: 0,
      });
  }

  it("interactive + no --host + tailscale IP present → offers it; accepting binds the tailnet IP", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      // Accept the tailscale offer (keyed on "tailscale"); decline the env write.
      const prompter = new FakePrompter({
        answers: { tailscale: "y", "~/.librarian/env": "n" },
      });

      const r = await runCli(["server", "up"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      // Offered (a prompt mentioning tailscale was shown)...
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        true,
      );
      // ...and accepted → bound to the tailnet IP (ALLOW_NO_AUTH omitted).
      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain(`${TAILNET}:3838:3838`);
      expect(runArgs).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    });
  });

  it("interactive + tailscale IP present but DECLINED → stays on 127.0.0.1", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({
        answers: { tailscale: "n", "~/.librarian/env": "n" },
      });

      const r = await runCli(["server", "up"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      expect(runArgs).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    });
  });

  it("--yes never offers tailscale (stays 127.0.0.1, no silent exposure)", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({});

      const r = await runCli(["server", "up", "--yes"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      expect(runArgs).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        false,
      );
    });
  });

  it("non-interactive never offers tailscale (stays 127.0.0.1)", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter, interactive: false });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      expect(runArgs).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        false,
      );
    });
  });

  it("tailscale absent (which → null) → no offer, no error (silent skip)", async () => {
    await withTempHome(async (home) => {
      // healthyRunner does NOT mark tailscale present → which() returns null.
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      // No tailscale probe call recorded beyond which(); no tailscale prompt.
      expect(runner.calls.some((c) => c.cmd === "tailscale" && c.args[0] === "ip")).toBe(false);
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        false,
      );
      // Stayed on localhost.
      expect(dockerRunArgs(runner)).toContain("127.0.0.1:3838:3838");
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

  it("beyond-localhost omits ALLOW_NO_AUTH and publishes on the chosen host", () => {
    const args = buildRunArgs({
      host: "100.1.2.3",
      dataVolume: "librarian_data",
      tag: "v1.0.0",
      agentToken: "tok",
    });
    expect(args).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    expect(args).toContain("100.1.2.3:3000:3000");
    expect(args).toContain("100.1.2.3:3838:3838");
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
