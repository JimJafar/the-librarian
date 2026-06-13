import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { resetRunner, setRunner } from "../src/exec.js";
import { resetHomeOverride, setHomeOverride } from "../src/paths.js";
import { createPrompter } from "../src/prompt.js";
import { runCli } from "../src/runtime.js";
import { cliVersion } from "../src/version.js";
import { FakeRunner, withTempHome } from "./helpers.js";

const TOKEN = "cli-test-secret-token";

describe("runCli — help & version", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Usage: librarian/);
  });

  it("no args prints usage", async () => {
    expect((await runCli([])).stdout).toMatch(/Usage: librarian/);
  });

  it("--version prints the package version", async () => {
    const r = await runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(cliVersion());
  });

  it("unknown command exits 1 with usage on stderr", async () => {
    const r = await runCli(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Unknown command/);
  });
});

describe("runCli — Phase 2 stubs", () => {
  for (const cmd of ["self-update", "report"]) {
    it(`${cmd} is a friendly "coming in a later release" stub (exit 0)`, async () => {
      const r = await runCli([cmd]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/coming in a later release/i);
    });
  }
});

describe("runCli — robustness (no leaked stack traces)", () => {
  it("non-interactive install with no saved config fails cleanly (exit 1, friendly stderr)", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      try {
        // A genuinely non-interactive prompter: no TTY, no injected answers.
        // resolveConfig will need the MCP URL with no default → MissingValueError.
        const prompter = createPrompter({
          input: new PassThrough(),
          output: new PassThrough(),
          interactive: false,
        });
        // Inject an EMPTY env so the test never reads (or depends on) the real
        // `process.env` — a dev box with LIBRARIAN_* set must not flip the result.
        const r = await runCli(["install"], { home, shell: "bash", prompter, env: {} });

        expect(r.exitCode).toBe(1);
        // A single friendly line, naming the fix — and NO stack trace.
        expect(r.stderr).toMatch(/MCP URL and token are required/);
        expect(r.stderr).toMatch(/--mcp-url/);
        expect(r.stderr).not.toMatch(/MissingValueError/);
        expect(r.stderr).not.toMatch(/\bat .*\.(ts|js):\d+/);
        expect(r.stdout).toBe("");
      } finally {
        resetRunner();
        resetHomeOverride();
      }
    });
  });
});

describe("runCli — config (fully working)", () => {
  it("config with no args before setup explains how to set it", async () => {
    await withTempHome(async (home) => {
      const r = await runCli(["config"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/No config set yet/);
    });
  });

  it("config --mcp-url --token persists and confirms without echoing the token", async () => {
    await withTempHome(async (home) => {
      const r = await runCli(
        ["config", "--mcp-url", "https://mcp.example.com/mcp", "--token", TOKEN],
        { home, shell: "bash" },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain(TOKEN);
      expect(r.stdout).toContain("set (hidden)");
    });
  });

  it("config show after set reports the url + server url but redacts the token", async () => {
    await withTempHome(async (home) => {
      await runCli(["config", "--mcp-url", "https://mcp.example.com/mcp", "--token", TOKEN], {
        home,
        shell: "bash",
      });
      const r = await runCli(["config"], { home });
      expect(r.stdout).toContain("https://mcp.example.com/mcp");
      expect(r.stdout).toContain("https://mcp.example.com");
      expect(r.stdout).not.toContain(TOKEN);
    });
  });
});
