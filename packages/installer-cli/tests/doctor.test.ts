import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { doctor, resetServerProbe, setServerProbe } from "../src/doctor.js";
import { resetRunner, setRunner } from "../src/exec.js";
import { envFilePath, resetHomeOverride, setHomeOverride } from "../src/paths.js";
import { runCli } from "../src/runtime.js";
import { FakeRunner, withTempHome } from "./helpers.js";

const URL = "https://mcp.example.com/mcp";
const TOKEN = "doctor-secret-token";

afterEach(() => {
  resetRunner();
  resetHomeOverride();
  resetServerProbe();
});

function seedConfig(home: string): void {
  fs.mkdirSync(`${home}/.librarian`, { recursive: true });
  fs.writeFileSync(
    envFilePath(home),
    `export LIBRARIAN_MCP_URL='${URL}'\nexport LIBRARIAN_AGENT_TOKEN='${TOKEN}'\n`,
    { mode: 0o600 },
  );
}

describe("doctor", () => {
  it("reports token as 'set' (never the value), the reachable server, present CLIs, machine id", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedConfig(home);
      setRunner(new FakeRunner().withWhich("claude").withWhich("codex"));
      setServerProbe(async () => ({ ok: true, detail: "HTTP 200 /healthz" }));

      const report = await doctor(home);

      expect(report).toMatch(/Token:\s+set/);
      expect(report).not.toContain(TOKEN); // value never printed
      expect(report).toMatch(/Server:\s+reachable/);
      expect(report).toMatch(/Claude Code: `claude` found/);
      expect(report).toMatch(/Codex: `codex` found/);
      expect(report).toMatch(/Pi: `pi` NOT on PATH/);
      // File-based harnesses are labelled, not probed for a CLI.
      expect(report).toMatch(/OpenCode: file-based/);
      expect(report).toMatch(/Hermes: file-based/);
      // Machine identity present.
      expect(report).toMatch(/Machine id:\s+\S+/);
      expect(report).toMatch(/Hostname:\s+\S+/);
      expect(report).toMatch(/All checks passed/);
    });
  });

  it("flags an unset token and an unreachable server but still exits 0", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      setServerProbe(async () => ({ ok: false, detail: "ECONNREFUSED" }));

      const r = await runCli(["doctor"], { home });
      expect(r.exitCode).toBe(0); // diagnostic always exits 0
      expect(r.stdout).toMatch(/Token:\s+NOT SET/);
      expect(r.stdout).toMatch(/Server:\s+UNREACHABLE/);
      expect(r.stdout).toMatch(/need attention/);
    });
  });
});
