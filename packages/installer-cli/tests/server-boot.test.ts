// S6 — boot persistence (Linux systemd; macOS deferred).
//
// The whole point of this slice is a systemd unit that survives reboots AND
// `server update` WITHOUT leaking a secret. The container created by `up`/
// `update` already holds the agent token in Docker's own state, so the unit
// references the EXISTING named container (`docker start --attach the-librarian`)
// rather than re-running `docker run -e LIBRARIAN_AGENT_TOKEN=…`, which would
// write the token into a world-readable `/etc/systemd/system/*.service` file.
//
// Every test drives the seam: the unit generator is a PURE function (the
// headline no-secret test asserts its text directly), and `enableBoot`/
// `disableBoot` route `systemctl`/`sudo` through the injected `docker.ts`
// FakeRunner so the EXACT argv is asserted — no real systemd, sudo, or docker.

import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { disableBoot, enableBoot, generateUnit, UNIT_NAME, unitPath } from "../src/server/boot.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import { CONTAINER_NAME } from "../src/server/up.js";
import { FakeRunner } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
});

const UNIT_PATH = "/etc/systemd/system/the-librarian.service";

/** A FakeRunner with systemctl/sudo present and all calls succeeding. */
function systemdReady(): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("systemctl")
    .withWhich("sudo")
    .withFallback({ code: 0 });
}

/** The argv of a recorded `sudo systemctl …` call (after `sudo`), or undefined. */
function systemctlArgs(runner: FakeRunner, ...match: string[]): boolean {
  return runner.calls.some(
    (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && match.every((m) => c.args.includes(m)),
  );
}

describe("generateUnit — the headline: NO SECRET in the unit (SC 7 + privacy)", () => {
  it("references the named container via `docker start` — no token, no `docker run`", () => {
    const unit = generateUnit({ dockerPath: "/usr/bin/docker" });

    // The invariant. None of these may EVER appear in the unit text.
    expect(unit).not.toContain("LIBRARIAN_AGENT_TOKEN");
    expect(unit).not.toContain("docker run");
    expect(unit).not.toMatch(/-e\s/); // no `-e <env>` env injection at all
    expect(unit).not.toMatch(/token/i);
    expect(unit).not.toMatch(/secret/i);
    expect(unit).not.toMatch(/key/i);

    // What it MUST contain: a `docker start` referencing the named container.
    expect(unit).toContain(`/usr/bin/docker start --attach ${CONTAINER_NAME}`);
    expect(unit).toContain(`/usr/bin/docker stop ${CONTAINER_NAME}`);
  });

  it("is a well-formed systemd unit (sections + boot wiring)", () => {
    const unit = generateUnit({ dockerPath: "/usr/bin/docker" });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("After=docker.service");
    expect(unit).toContain("Requires=docker.service");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toMatch(/Restart=always/);
  });

  it("honours a resolved docker path other than /usr/bin/docker", () => {
    const unit = generateUnit({ dockerPath: "/opt/homebrew/bin/docker" });
    expect(unit).toContain(`/opt/homebrew/bin/docker start --attach ${CONTAINER_NAME}`);
    expect(unit).not.toContain("/usr/bin/docker start");
  });
});

describe("enableBoot (linux) — writes the unit, daemon-reload, enable --now", () => {
  it("writes the unit to /etc/systemd/system, reloads, then enables --now (with sudo)", async () => {
    const runner = systemdReady();
    // Capture the temp unit content AT THE MOMENT of the `sudo cp` (before the
    // flow's `finally` removes the temp dir) — the FakeRunner doesn't really
    // copy, so we read the source file the implementation handed `cp`.
    let copiedContent: string | undefined;
    let copiedDest: string | undefined;
    const realRun = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      if (cmd === "sudo" && args[0] === "cp") {
        copiedContent = fs.readFileSync(args[1] as string, "utf8");
        copiedDest = args[2];
      }
      return realRun(cmd, args, opts);
    };
    setDockerRunner(runner);

    const result = await enableBoot({ platform: "linux" });

    // The unit landed at the system path with the right content (no secret).
    expect(copiedDest).toBe(UNIT_PATH);
    expect(copiedContent).toContain(`docker start --attach ${CONTAINER_NAME}`);
    expect(copiedContent).not.toContain("LIBRARIAN_AGENT_TOKEN");
    expect(copiedContent).not.toMatch(/token|secret|key/i);

    // daemon-reload BEFORE enable --now.
    expect(systemctlArgs(runner, "daemon-reload")).toBe(true);
    expect(systemctlArgs(runner, "enable", "--now", UNIT_NAME)).toBe(true);

    // Ordering: the unit write precedes daemon-reload precedes enable.
    const idxWrite = runner.calls.findIndex(
      (c) => c.cmd === "sudo" && c.args.includes(UNIT_PATH) && c.args[0] !== "systemctl",
    );
    const idxReload = runner.calls.findIndex(
      (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("daemon-reload"),
    );
    const idxEnable = runner.calls.findIndex(
      (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("enable"),
    );
    expect(idxWrite).toBeGreaterThanOrEqual(0);
    expect(idxWrite).toBeLessThan(idxReload);
    expect(idxReload).toBeLessThan(idxEnable);

    expect(result.output).toMatch(/boot/i);
  });

  it("is idempotent: running twice rewrites the unit + re-enables, no duplicate units", async () => {
    const runner = systemdReady();
    setDockerRunner(runner);

    await enableBoot({ platform: "linux" });
    await enableBoot({ platform: "linux" });

    // Both runs targeted the SAME unit path (no `the-librarian-2.service` etc).
    const enables = runner.calls.filter(
      (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("enable"),
    );
    expect(enables.length).toBe(2);
    for (const e of enables) expect(e.args).toContain(UNIT_NAME);
    // No alternate unit name was ever created.
    expect(
      runner.calls.some((c) =>
        c.args.some((a) => /the-librarian-\d|the-librarian\.service\.\d/.test(a)),
      ),
    ).toBe(false);
  });
});

describe("disableBoot (linux) — disable --now, remove the unit, daemon-reload", () => {
  it("disables --now, then removes the unit file, then daemon-reloads", async () => {
    const runner = systemdReady();
    setDockerRunner(runner);

    const result = await disableBoot({ platform: "linux" });

    expect(systemctlArgs(runner, "disable", "--now", UNIT_NAME)).toBe(true);
    // The unit file was removed (sudo rm of the unit path).
    expect(
      runner.calls.some(
        (c) => c.cmd === "sudo" && c.args[0] === "rm" && c.args.includes(UNIT_PATH),
      ),
    ).toBe(true);
    expect(systemctlArgs(runner, "daemon-reload")).toBe(true);

    // Ordering: disable precedes rm precedes daemon-reload.
    const idxDisable = runner.calls.findIndex(
      (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("disable"),
    );
    const idxRm = runner.calls.findIndex((c) => c.cmd === "sudo" && c.args[0] === "rm");
    const idxReload = runner.calls.findIndex(
      (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("daemon-reload"),
    );
    expect(idxDisable).toBeLessThan(idxRm);
    expect(idxRm).toBeLessThan(idxReload);

    expect(result.output).toMatch(/disabled|removed|boot/i);
  });

  it("already-disabled/absent unit is a friendly message, not a crash", async () => {
    // systemctl disable on an unknown unit exits non-zero with a "not loaded" note.
    const runner = systemdReady()
      .onRun("sudo", ["systemctl", "disable", "--now", UNIT_NAME], {
        stderr: "Failed to disable unit: Unit the-librarian.service does not exist.\n",
        code: 1,
      })
      .onRun("sudo", ["rm", "-f", UNIT_PATH], { code: 0 });
    setDockerRunner(runner);

    const result = await disableBoot({ platform: "linux" });
    expect(result.output).toMatch(/already|not.*enabled|nothing|removed|boot/i);
    // No stack trace leaked into the message.
    expect(result.output).not.toMatch(/at \w+.*\(/);
  });
});

describe("boot persistence — macOS is a clear deferred notice, never an error", () => {
  it("enableBoot on darwin prints the Linux-only notice and runs NO systemctl", async () => {
    const runner = systemdReady();
    setDockerRunner(runner);

    const result = await enableBoot({ platform: "darwin" });
    expect(result.output).toMatch(/linux-only|linux only|launchd|deferred/i);
    // Nothing touched systemd.
    expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
    expect(runner.calls.some((c) => c.args.includes("systemctl"))).toBe(false);
  });

  it("disableBoot on darwin prints the notice and runs NO systemctl", async () => {
    const runner = systemdReady();
    setDockerRunner(runner);

    const result = await disableBoot({ platform: "darwin" });
    expect(result.output).toMatch(/linux-only|linux only|launchd|deferred/i);
    expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
  });
});

describe("boot — paths/constants are stable", () => {
  it("unitPath() is the system path, UNIT_NAME is the service file name", () => {
    expect(UNIT_NAME).toBe("the-librarian.service");
    expect(unitPath()).toBe(UNIT_PATH);
  });
});
