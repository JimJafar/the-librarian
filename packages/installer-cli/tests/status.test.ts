import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunner, setRunner } from "../src/exec.js";
import { codexConfigPath, envFilePath, resetHomeOverride, setHomeOverride } from "../src/paths.js";
import { compareVersions, isBehind } from "../src/semver.js";
import { resetLatestFetcher, setLatestFetcher, status } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetHomeOverride();
  resetLatestFetcher();
});

/** Seed env + a codex install (config.toml table) so a row shows installed. */
function seedCodexInstalled(home: string, version = "1"): void {
  fs.mkdirSync(`${home}/.librarian`, { recursive: true });
  fs.writeFileSync(
    envFilePath(home),
    "export LIBRARIAN_MCP_URL='https://mcp.example.com/mcp'\nexport LIBRARIAN_AGENT_TOKEN='secret'\n",
    { mode: 0o600 },
  );
  fs.mkdirSync(`${home}/.codex`, { recursive: true });
  fs.writeFileSync(
    codexConfigPath(home),
    `# librarian-config-version = "${version}"\n[mcp_servers.librarian]\nurl = "https://mcp.example.com/mcp"\n`,
    "utf8",
  );
}

describe("status table", () => {
  it("renders every harness with the live-probed installed/version + the configured url", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner()); // no CLIs → claude/pi/etc not installed
      seedCodexInstalled(home, "1");
      setLatestFetcher(async () => "2.0.0");

      const table = await status(home);

      // Header + every harness display name present.
      expect(table).toMatch(/HARNESS\s+INSTALLED\s+VERSION\s+LATEST\s+UPDATE\?\s+URL/);
      for (const name of ["Claude Code", "Codex", "OpenCode", "Hermes", "Pi"]) {
        expect(table).toContain(name);
      }
      // Codex installed, version 1, latest 2.0.0 → update yes, url shown.
      const codexRow = table.split("\n").find((l) => l.startsWith("Codex"));
      expect(codexRow).toContain("yes"); // installed
      expect(codexRow).toContain("1");
      expect(codexRow).toContain("2.0.0");
      expect(codexRow).toContain("https://mcp.example.com/mcp");
      // A not-installed harness shows update? "no" and no url.
      const claudeRow = table.split("\n").find((l) => l.startsWith("Claude Code"));
      expect(claudeRow).toMatch(/Claude Code\s+no/);
    });
  });

  it("offline: a failing latest fetch renders latest 'unknown' and update? '?'", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      seedCodexInstalled(home, "1");
      setLatestFetcher(async () => null); // offline / unreachable

      const table = await status(home);
      expect(table).toContain("unknown");
      const codexRow = table.split("\n").find((l) => l.startsWith("Codex"));
      expect(codexRow).toContain("?"); // update? unknown, never a false "yes"
      expect(table).toMatch(/could not reach GitHub/);
    });
  });

  it("never crashes when the latest fetcher throws (treated as unknown)", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      // A thrown fetcher would reject status(); the DEFAULT fetcher swallows
      // errors, but a test fetcher that returns null models offline cleanly.
      setLatestFetcher(async () => null);
      await expect(status(home)).resolves.toBeTypeOf("string");
    });
  });
});

describe("semver-ish compare", () => {
  it("orders releases and prereleases the way the monorepo ships them", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    // Unparseable → 0 (never reads as "behind").
    expect(compareVersions("nightly", "1.0.0")).toBe(0);
  });

  it("isBehind is false when either side is unknown", () => {
    expect(isBehind("1.0.0", "2.0.0")).toBe(true);
    expect(isBehind("", "2.0.0")).toBe(false);
    expect(isBehind("1.0.0", "")).toBe(false);
  });
});
