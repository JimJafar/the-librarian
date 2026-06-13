import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "../src/commands/install.js";
import { resetRunner, setRunner } from "../src/exec.js";
import {
  resetHomeOverride,
  setHomeOverride,
  codexConfigPath,
  opencodeConfigPath,
  bashRcPath,
  envFilePath,
} from "../src/paths.js";
import { runCli } from "../src/runtime.js";
import { FakeRunner, withTempHome } from "./helpers.js";
import { FakePrompter } from "./prompter.js";

const URL = "https://mcp.example.com/mcp";
const TOKEN = "install-secret-token-123";

afterEach(() => {
  resetRunner();
  resetHomeOverride();
});

describe("install orchestration", () => {
  it("prompts for URL+token, persists config, applies the env block, installs harnesses", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // No `codex` on PATH → codex install writes config.toml directly (so the
      // file the FakeRunner can't write actually lands and detect() sees it).
      setRunner(new FakeRunner());
      const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });

      const outcome = await runInstall(["codex", "opencode"], { home, shell: "bash", prompter });

      // Both harnesses installed.
      expect(outcome.installed.sort()).toEqual(["codex", "opencode"]);
      expect(outcome.failed).toHaveLength(0);
      expect(outcome.skipped).toHaveLength(0);

      // Config persisted to ~/.librarian/env, with the token (600 file).
      const env = fs.readFileSync(envFilePath(home), "utf8");
      expect(env).toContain(`export LIBRARIAN_MCP_URL='${URL}'`);
      expect(env).toContain(`export LIBRARIAN_AGENT_TOKEN='${TOKEN}'`);

      // Managed shell block applied to ~/.bashrc.
      const rc = fs.readFileSync(bashRcPath(home), "utf8");
      expect(rc).toContain("# >>> librarian >>>");

      // Codex config written; opencode config written; neither leaks the token.
      const codexCfg = fs.readFileSync(codexConfigPath(home), "utf8");
      expect(codexCfg).toContain("[mcp_servers.librarian]");
      const ocCfg = fs.readFileSync(opencodeConfigPath(home), "utf8");
      expect(ocCfg).toContain('"librarian"');
      expect(codexCfg + ocCfg).not.toContain(TOKEN);

      // Summary mentions the installed harnesses + a restart hint, never the token.
      expect(outcome.output).toContain("Installed: codex, opencode");
      expect(outcome.output).toMatch(/source ~\/\.librarian\/env/);
      expect(outcome.output).not.toContain(TOKEN);
    });
  });

  it("skips a harness whose CLI is absent (not a failure)", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // No `claude` on PATH → claude.install throws "CLI not found".
      setRunner(new FakeRunner());
      const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });

      const outcome = await runInstall(["claude"], { home, shell: "bash", prompter });

      expect(outcome.installed).toHaveLength(0);
      expect(outcome.failed).toHaveLength(0);
      expect(outcome.skipped.map((s) => s.id)).toEqual(["claude"]);
      expect(outcome.output).toMatch(/Skipped claude:/);
    });
  });

  it("rolls back a harness on a mid-install error (uninstall called)", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // `codex` present, but `codex mcp add` fails non-zero → mid-install error.
      const runner = new FakeRunner()
        .withWhich("codex")
        .onRun(
          "codex",
          [
            "mcp",
            "add",
            "librarian",
            "--url",
            URL,
            "--bearer-token-env-var",
            "LIBRARIAN_AGENT_TOKEN",
          ],
          { code: 1, stderr: "boom" },
        );
      setRunner(runner);
      const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });

      const outcome = await runInstall(["codex"], { home, shell: "bash", prompter });

      expect(outcome.installed).toHaveLength(0);
      expect(outcome.failed.map((f) => f.id)).toEqual(["codex"]);
      // Rollback attempted: `codex mcp remove librarian` was run.
      expect(runner.ran("codex", ["mcp", "remove", "librarian"])).toBe(true);
      expect(outcome.output).toMatch(/rolled back/);
    });
  });

  it("an unknown named harness is noted and skipped, not crashed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      // Config already set so no prompts needed.
      fs.mkdirSync(`${home}/.librarian`, { recursive: true });
      fs.writeFileSync(
        envFilePath(home),
        `export LIBRARIAN_MCP_URL='${URL}'\nexport LIBRARIAN_AGENT_TOKEN='${TOKEN}'\n`,
        { mode: 0o600 },
      );
      const prompter = new FakePrompter();

      const outcome = await runInstall(["bogus", "opencode"], { home, shell: "bash", prompter });
      expect(outcome.output).toMatch(/unknown harness: bogus/);
      expect(outcome.installed).toEqual(["opencode"]);
    });
  });

  it("does NOT write ~/.librarian/env or the rc block when every harness fails", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // `codex` present but its `mcp add` fails → the only chosen harness fails.
      const runner = new FakeRunner()
        .withWhich("codex")
        .onRun(
          "codex",
          [
            "mcp",
            "add",
            "librarian",
            "--url",
            URL,
            "--bearer-token-env-var",
            "LIBRARIAN_AGENT_TOKEN",
          ],
          { code: 1, stderr: "boom" },
        );
      setRunner(runner);
      const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });

      const outcome = await runInstall(["codex"], { home, shell: "bash", prompter });

      expect(outcome.installed).toHaveLength(0);
      expect(outcome.failed.map((f) => f.id)).toEqual(["codex"]);

      // No global side effect: a total failure leaves no env file and no rc block.
      expect(fs.existsSync(envFilePath(home))).toBe(false);
      expect(fs.existsSync(bashRcPath(home))).toBe(false);
    });
  });

  it("DOES persist config once at least one harness install succeeds", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner()); // no codex CLI → file-based install writes config.toml
      const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });

      const outcome = await runInstall(["codex"], { home, shell: "bash", prompter });

      expect(outcome.installed).toEqual(["codex"]);
      // Persisted only after a success.
      const env = fs.readFileSync(envFilePath(home), "utf8");
      expect(env).toContain(`export LIBRARIAN_MCP_URL='${URL}'`);
      expect(env).toContain(`export LIBRARIAN_AGENT_TOKEN='${TOKEN}'`);
      expect(fs.readFileSync(bashRcPath(home), "utf8")).toContain("# >>> librarian >>>");
    });
  });

  it("through runCli: a mid-install failure exits non-zero but still reports", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      const runner = new FakeRunner()
        .withWhich("codex")
        .onRun(
          "codex",
          [
            "mcp",
            "add",
            "librarian",
            "--url",
            URL,
            "--bearer-token-env-var",
            "LIBRARIAN_AGENT_TOKEN",
          ],
          { code: 1, stderr: "nope" },
        );
      setRunner(runner);
      const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });

      const r = await runCli(["install", "codex"], { home, shell: "bash", prompter });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/Failed codex/);
    });
  });
});
