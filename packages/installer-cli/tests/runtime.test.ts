import { describe, expect, it } from "vitest";
import { runCli } from "../src/runtime.js";
import { cliVersion } from "../src/version.js";
import { withTempHome } from "./helpers.js";

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
