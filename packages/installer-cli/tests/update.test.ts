import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInstall } from "../src/commands/install.js";
import { runUpdate } from "../src/commands/update.js";
import { resetRunner, setRunner } from "../src/exec.js";
import { envFilePath, resetHomeOverride, setHomeOverride } from "../src/paths.js";
import { FakeRunner, useOfflineOpencodeCapture, withTempHome } from "./helpers.js";
import { FakePrompter } from "./prompter.js";

const URL = "https://mcp.example.com/mcp";
const TOKEN = "update-secret-token";

// opencode.install/update now also wire the per-turn auto-capture PLUGIN, fetched
// from the pinned release; register the OFFLINE fixture fetcher so the
// opencode-installing test here never reaches the network.
let cleanupOpencodeCapture: (() => void) | undefined;
beforeEach(() => {
  cleanupOpencodeCapture = useOfflineOpencodeCapture();
});

afterEach(() => {
  resetRunner();
  resetHomeOverride();
  cleanupOpencodeCapture?.();
  cleanupOpencodeCapture = undefined;
});

function seedConfig(home: string): void {
  fs.mkdirSync(`${home}/.librarian`, { recursive: true });
  fs.writeFileSync(
    envFilePath(home),
    `export LIBRARIAN_MCP_URL='${URL}'\nexport LIBRARIAN_AGENT_TOKEN='${TOKEN}'\n`,
    { mode: 0o600 },
  );
}

describe("update orchestration", () => {
  it("errors clearly when no config is set", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      const outcome = await runUpdate([], { home });
      expect(outcome.output).toMatch(/No config set/);
      expect(outcome.updated).toHaveLength(0);
    });
  });

  it("with no args, updates only currently-installed harnesses and reports the version", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      // Install opencode so it's the only installed harness.
      const installer = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });
      await runInstall(["opencode"], { home, shell: "bash", prompter: installer, env: {} });

      const outcome = await runUpdate([], { home });
      expect(outcome.updated.map((u) => u.id)).toEqual(["opencode"]);
      // opencode stamps a fixed managed version, so from === to (idempotent).
      expect(outcome.output).toMatch(/opencode: already at \d/);
    });
  });

  it("reports 'nothing to update' when no harness is installed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedConfig(home);
      setRunner(new FakeRunner());
      const outcome = await runUpdate([], { home });
      expect(outcome.output).toMatch(/No harnesses are currently installed/);
    });
  });

  it("a named harness whose CLI is absent is skipped, not failed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedConfig(home);
      setRunner(new FakeRunner()); // no `claude`
      const outcome = await runUpdate(["claude"], { home });
      expect(outcome.skipped.map((s) => s.id)).toEqual(["claude"]);
      expect(outcome.failed).toHaveLength(0);
    });
  });
});
