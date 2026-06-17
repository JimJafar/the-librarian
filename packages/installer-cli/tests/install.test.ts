import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { FakeRunner, useOfflineCodexCapture, withTempHome } from "./helpers.js";
import { FakePrompter } from "./prompter.js";

const URL = "https://mcp.example.com/mcp";
const TOKEN = "install-secret-token-123";

// codex.install now also wires the per-turn auto-capture hooks, fetching the
// adapter from the pinned release. Register the OFFLINE fixture fetcher so these
// orchestration tests (which install codex) never reach the network.
let cleanupCodexCapture: (() => void) | undefined;
beforeEach(() => {
  cleanupCodexCapture = useOfflineCodexCapture();
});

afterEach(() => {
  resetRunner();
  resetHomeOverride();
  cleanupCodexCapture?.();
  cleanupCodexCapture = undefined;
});

describe("install orchestration", () => {
  it("prompts for URL+token, persists config, applies the env block, installs harnesses", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // No `codex` on PATH → codex install writes config.toml directly (so the
      // file the FakeRunner can't write actually lands and detect() sees it).
      setRunner(new FakeRunner());
      const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });

      const outcome = await runInstall(["codex", "opencode"], {
        home,
        shell: "bash",
        prompter,
        env: {},
      });

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

      const outcome = await runInstall(["claude"], { home, shell: "bash", prompter, env: {} });

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

      const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env: {} });

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

      const outcome = await runInstall(["bogus", "opencode"], {
        home,
        shell: "bash",
        prompter,
        env: {},
      });
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

      const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env: {} });

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

      const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env: {} });

      expect(outcome.installed).toEqual(["codex"]);
      // Persisted only after a success.
      const env = fs.readFileSync(envFilePath(home), "utf8");
      expect(env).toContain(`export LIBRARIAN_MCP_URL='${URL}'`);
      expect(env).toContain(`export LIBRARIAN_AGENT_TOKEN='${TOKEN}'`);
      expect(fs.readFileSync(bashRcPath(home), "utf8")).toContain("# >>> librarian >>>");
    });
  });

  // --- BUG 2: reuse existing LIBRARIAN_* environment variables ------------

  describe("existing environment variables (BUG 2)", () => {
    const ENV_URL = "https://env.example.com/mcp";
    const ENV_TOKEN = "env-secret-token-xyz";

    it("offers BOTH env vars, and on accept uses + persists them without re-prompting", async () => {
      await withTempHome(async (home) => {
        setHomeOverride(home);
        setRunner(new FakeRunner()); // no codex CLI → file-based install succeeds
        // Both env vars present; FakePrompter has NO scripted answer for the
        // offer, so it returns the "y" default → accepted.
        const prompter = new FakePrompter();
        const env = { LIBRARIAN_MCP_URL: ENV_URL, LIBRARIAN_AGENT_TOKEN: ENV_TOKEN };

        const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env });

        expect(outcome.installed).toEqual(["codex"]);
        // Exactly one prompt was shown — the reuse offer — and NO url/token prompts.
        expect(prompter.textCalls).toHaveLength(1);
        expect(prompter.textCalls[0]?.question).toMatch(/Use the LIBRARIAN_MCP_URL/);
        // The offer shows the URL but redacts the token (never its value).
        expect(prompter.textCalls[0]?.question).toContain(ENV_URL);
        expect(prompter.textCalls[0]?.question).toContain("LIBRARIAN_AGENT_TOKEN=set");
        expect(prompter.textCalls[0]?.question).not.toContain(ENV_TOKEN);

        // The env values were used and persisted to ~/.librarian/env.
        const persisted = fs.readFileSync(envFilePath(home), "utf8");
        expect(persisted).toContain(`export LIBRARIAN_MCP_URL='${ENV_URL}'`);
        expect(persisted).toContain(`export LIBRARIAN_AGENT_TOKEN='${ENV_TOKEN}'`);
      });
    });

    it("offers BOTH env vars, and on decline prompts for fresh values", async () => {
      await withTempHome(async (home) => {
        setHomeOverride(home);
        setRunner(new FakeRunner());
        const prompter = new FakePrompter({
          answers: {
            environment: "n", // decline the reuse offer
            "mcp url": URL, // fresh URL
            token: TOKEN, // fresh token
          },
        });
        const env = { LIBRARIAN_MCP_URL: ENV_URL, LIBRARIAN_AGENT_TOKEN: ENV_TOKEN };

        const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env });

        expect(outcome.installed).toEqual(["codex"]);
        // Offer + the two fresh prompts were shown.
        const questions = prompter.textCalls.map((c) => c.question);
        expect(questions.some((q) => /Use the LIBRARIAN_MCP_URL/.test(q))).toBe(true);
        expect(questions.some((q) => q === "MCP URL")).toBe(true);
        expect(questions.some((q) => q === "Agent token")).toBe(true);

        // The FRESH values were persisted, NOT the env ones.
        const persisted = fs.readFileSync(envFilePath(home), "utf8");
        expect(persisted).toContain(`export LIBRARIAN_MCP_URL='${URL}'`);
        expect(persisted).toContain(`export LIBRARIAN_AGENT_TOKEN='${TOKEN}'`);
        expect(persisted).not.toContain(ENV_URL);
      });
    });

    it("with only ONE env var present, prefills it as that prompt's default", async () => {
      await withTempHome(async (home) => {
        setHomeOverride(home);
        setRunner(new FakeRunner());
        // Only the URL is in the env; the user accepts it by hitting enter (the
        // FakePrompter returns the prompt's default for an unscripted question),
        // and supplies the token.
        const prompter = new FakePrompter({ answers: { token: TOKEN } });
        const env = { LIBRARIAN_MCP_URL: ENV_URL };

        const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env });

        expect(outcome.installed).toEqual(["codex"]);
        // No reuse offer (only one var) — straight to the prompts.
        const offer = prompter.textCalls.find((c) => /Use the LIBRARIAN_MCP_URL/.test(c.question));
        expect(offer).toBeUndefined();
        // The MCP URL prompt carried the env value as its default.
        const urlCall = prompter.textCalls.find((c) => c.question === "MCP URL");
        expect(urlCall?.opts.default).toBe(ENV_URL);

        // The env URL (accepted via default) + the typed token were persisted.
        const persisted = fs.readFileSync(envFilePath(home), "utf8");
        expect(persisted).toContain(`export LIBRARIAN_MCP_URL='${ENV_URL}'`);
        expect(persisted).toContain(`export LIBRARIAN_AGENT_TOKEN='${TOKEN}'`);
      });
    });

    it("with NEITHER env var present, prompts for both as before", async () => {
      await withTempHome(async (home) => {
        setHomeOverride(home);
        setRunner(new FakeRunner());
        const prompter = new FakePrompter({ answers: { "mcp url": URL, token: TOKEN } });
        const env = {}; // no LIBRARIAN_* vars

        const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env });

        expect(outcome.installed).toEqual(["codex"]);
        const offer = prompter.textCalls.find((c) => /Use the LIBRARIAN_MCP_URL/.test(c.question));
        expect(offer).toBeUndefined();
        // Neither prompt carried an env default.
        const urlCall = prompter.textCalls.find((c) => c.question === "MCP URL");
        expect(urlCall?.opts.default).toBeUndefined();

        const persisted = fs.readFileSync(envFilePath(home), "utf8");
        expect(persisted).toContain(`export LIBRARIAN_MCP_URL='${URL}'`);
        expect(persisted).toContain(`export LIBRARIAN_AGENT_TOKEN='${TOKEN}'`);
      });
    });

    it("an already-complete ~/.librarian/env wins — env vars are ignored, no prompt", async () => {
      await withTempHome(async (home) => {
        setHomeOverride(home);
        setRunner(new FakeRunner());
        fs.mkdirSync(`${home}/.librarian`, { recursive: true });
        fs.writeFileSync(
          envFilePath(home),
          `export LIBRARIAN_MCP_URL='${URL}'\nexport LIBRARIAN_AGENT_TOKEN='${TOKEN}'\n`,
          { mode: 0o600 },
        );
        const prompter = new FakePrompter();
        const env = { LIBRARIAN_MCP_URL: ENV_URL, LIBRARIAN_AGENT_TOKEN: ENV_TOKEN };

        const outcome = await runInstall(["codex"], { home, shell: "bash", prompter, env });

        expect(outcome.installed).toEqual(["codex"]);
        // Persisted config was already complete → no prompts at all.
        expect(prompter.textCalls).toHaveLength(0);
        const persisted = fs.readFileSync(envFilePath(home), "utf8");
        expect(persisted).toContain(`export LIBRARIAN_MCP_URL='${URL}'`);
        expect(persisted).not.toContain(ENV_URL);
      });
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

      const r = await runCli(["install", "codex"], { home, shell: "bash", prompter, env: {} });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/Failed codex/);
    });
  });
});
