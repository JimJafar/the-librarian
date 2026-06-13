import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "../src/commands/install.js";
import { runUninstall } from "../src/commands/uninstall.js";
import { resetRunner, setRunner } from "../src/exec.js";
import { bashRcPath, envFilePath, resetHomeOverride, setHomeOverride } from "../src/paths.js";
import { FakeRunner, withTempHome } from "./helpers.js";
import { FakePrompter } from "./prompter.js";

const URL = "https://mcp.example.com/mcp";
const TOKEN = "uninstall-secret-token";

afterEach(() => {
  resetRunner();
  resetHomeOverride();
});

/** Install opencode (file-based, no CLI gate) so something is installed. */
async function seedOpencode(home: string): Promise<void> {
  setRunner(new FakeRunner());
  const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });
  await runInstall(["opencode"], { home, shell: "bash", prompter });
}

describe("uninstall orchestration", () => {
  it("removes the harness and offers to remove the env when none remain (yes → removed)", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await seedOpencode(home);
      expect(fs.existsSync(envFilePath(home))).toBe(true);

      const prompter = new FakePrompter({ answers: { remove: "yes" } });
      const outcome = await runUninstall(["opencode"], { home, shell: "bash", prompter });

      expect(outcome.removed).toEqual(["opencode"]);
      expect(outcome.envRemoved).toBe(true);
      // The prompt that fired was the env-removal one, defaulting to no.
      expect(prompter.textCalls.some((c) => /remove/i.test(c.question))).toBe(true);
      // Env file gone, managed block stripped from the rc.
      expect(fs.existsSync(envFilePath(home))).toBe(false);
      expect(fs.readFileSync(bashRcPath(home), "utf8")).not.toContain("# >>> librarian >>>");
    });
  });

  it("defaults the env-removal prompt to NO — env is kept unless confirmed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await seedOpencode(home);

      // Prompter returns the default (no scripted "remove" answer) → "no".
      const prompter = new FakePrompter();
      const outcome = await runUninstall(["opencode"], { home, shell: "bash", prompter });

      expect(outcome.envRemoved).toBe(false);
      expect(fs.existsSync(envFilePath(home))).toBe(true);
      expect(outcome.output).toMatch(/Left the shell block/);
    });
  });

  it("does not offer env removal while another harness is still installed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // Install codex (via its file fallback, so detect() truly sees it) +
      // opencode, then uninstall only opencode.
      setRunner(new FakeRunner());
      const installer = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });
      await runInstall(["codex", "opencode"], { home, shell: "bash", prompter: installer });

      const prompter = new FakePrompter();
      const outcome = await runUninstall(["opencode"], { home, shell: "bash", prompter });

      expect(outcome.removed).toEqual(["opencode"]);
      // No env-removal prompt fired (codex remains installed).
      expect(prompter.textCalls).toHaveLength(0);
      expect(fs.existsSync(envFilePath(home))).toBe(true);
    });
  });

  it("uninstall is no-op safe when nothing is installed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      const prompter = new FakePrompter();
      const outcome = await runUninstall(["opencode"], { home, shell: "bash", prompter });
      expect(outcome.removed).toEqual(["opencode"]); // uninstall() ran, no-op
      expect(outcome.failed).toHaveLength(0);
    });
  });
});
