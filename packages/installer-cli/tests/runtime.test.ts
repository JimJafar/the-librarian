import { describe, expect, it } from "vitest";
import { runCli } from "../src/runtime.js";
import { cliVersion } from "../src/version.js";
import { withTempHome } from "./helpers.js";

const TOKEN = "cli-test-secret-token";

describe("runCli — help & version", () => {
  it("--help prints usage and exits 0", () => {
    const r = runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Usage: librarian/);
  });

  it("no args prints usage", () => {
    expect(runCli([]).stdout).toMatch(/Usage: librarian/);
  });

  it("--version prints the package version", () => {
    const r = runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(cliVersion());
  });

  it("unknown command exits 1 with usage on stderr", () => {
    const r = runCli(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Unknown command/);
  });
});

describe("runCli — placeholders", () => {
  for (const cmd of [
    "install",
    "uninstall",
    "update",
    "status",
    "doctor",
    "self-update",
    "report",
  ]) {
    it(`${cmd} routes to a not-yet-implemented placeholder (exit 0)`, () => {
      const r = runCli([cmd]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/not yet implemented/);
    });
  }

  it("install echoes named harnesses in the placeholder", () => {
    const r = runCli(["install", "claude", "codex"]);
    expect(r.stdout).toContain("claude, codex");
  });
});

describe("runCli — config (fully working)", () => {
  it("config with no args before setup explains how to set it", async () => {
    await withTempHome((home) => {
      const r = runCli(["config"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/No config set yet/);
    });
  });

  it("config --mcp-url --token persists and confirms without echoing the token", async () => {
    await withTempHome((home) => {
      const r = runCli(["config", "--mcp-url", "https://mcp.example.com/mcp", "--token", TOKEN], {
        home,
        shell: "bash",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain(TOKEN);
      expect(r.stdout).toContain("set (hidden)");
    });
  });

  it("config show after set reports the url + server url but redacts the token", async () => {
    await withTempHome((home) => {
      runCli(["config", "--mcp-url", "https://mcp.example.com/mcp", "--token", TOKEN], {
        home,
        shell: "bash",
      });
      const r = runCli(["config"], { home });
      expect(r.stdout).toContain("https://mcp.example.com/mcp");
      expect(r.stdout).toContain("https://mcp.example.com");
      expect(r.stdout).not.toContain(TOKEN);
    });
  });
});
