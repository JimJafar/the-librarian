import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunner, setRunner } from "../src/exec.js";
import { codex } from "../src/harnesses/codex.js";
import { codexConfigPath, resetHomeOverride, setHomeOverride } from "../src/paths.js";
import { FakeRunner, withTempHome } from "./helpers.js";

const CFG = {
  mcpUrl: "https://x.example/mcp",
  token: "secret-token-xyz",
  serverUrl: "https://x.example",
};

afterEach(() => {
  resetRunner();
  resetHomeOverride();
});

/** Seed a config.toml with the given body under `home`. */
function seedConfig(home: string, body: string): void {
  const file = codexConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

describe("codex harness", () => {
  it("detect: not installed when config.toml is absent", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await expect(codex.detect()).resolves.toEqual({ installed: false });
    });
  });

  it("detect: not installed when the table is absent", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedConfig(home, '[mcp_servers.other]\nurl = "https://y/mcp"\n');
      await expect(codex.detect()).resolves.toEqual({ installed: false });
    });
  });

  it("detect: installed + stamped version when the table is present", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedConfig(
        home,
        '# librarian-config-version = "1"\n[mcp_servers.librarian]\nurl = "https://x/mcp"\n',
      );
      await expect(codex.detect()).resolves.toEqual({ installed: true, version: "1" });
    });
  });

  it("install (CLI present): runs `codex mcp add` with url + bearer-token-env-var", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      const r = new FakeRunner().withWhich("codex");
      setRunner(r);
      await codex.install(CFG);
      expect(
        r.ran("codex", [
          "mcp",
          "add",
          "librarian",
          "--url",
          CFG.mcpUrl,
          "--bearer-token-env-var",
          "LIBRARIAN_AGENT_TOKEN",
        ]),
      ).toBe(true);
      // The token VALUE is never in the args; only the env-var name is.
      expect(JSON.stringify(r.calls)).not.toContain(CFG.token);
    });
  });

  it("install (CLI absent): falls back to writing the table into config.toml", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner()); // no `codex` on PATH
      await codex.install(CFG);
      const written = fs.readFileSync(codexConfigPath(home), "utf8");
      expect(written).toContain("[mcp_servers.librarian]");
      expect(written).toContain(`url = "${CFG.mcpUrl}"`);
      expect(written).toContain('bearer_token_env_var = "LIBRARIAN_AGENT_TOKEN"');
      expect(written).not.toContain(CFG.token); // token value never written
    });
  });

  it("install: idempotent — a second install adds no duplicate table", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      await codex.install(CFG);
      await codex.install(CFG);
      const written = fs.readFileSync(codexConfigPath(home), "utf8");
      const count = written
        .split("\n")
        .filter((l) => l.trim() === "[mcp_servers.librarian]").length;
      expect(count).toBe(1);
    });
  });

  it("install: preserves pre-existing config in the file", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedConfig(home, '[mcp_servers.other]\nurl = "https://y/mcp"\n');
      setRunner(new FakeRunner());
      await codex.install(CFG);
      const written = fs.readFileSync(codexConfigPath(home), "utf8");
      expect(written).toContain("[mcp_servers.other]");
      expect(written).toContain("[mcp_servers.librarian]");
    });
  });

  it("uninstall (CLI present): runs `codex mcp remove librarian` and strips the table", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedConfig(
        home,
        '[mcp_servers.other]\nurl = "https://y/mcp"\n\n# librarian-config-version = "1"\n[mcp_servers.librarian]\nurl = "https://x/mcp"\nbearer_token_env_var = "LIBRARIAN_AGENT_TOKEN"\n',
      );
      const r = new FakeRunner().withWhich("codex");
      setRunner(r);
      await codex.uninstall();
      expect(r.ran("codex", ["mcp", "remove", "librarian"])).toBe(true);
      const written = fs.readFileSync(codexConfigPath(home), "utf8");
      expect(written).not.toContain("[mcp_servers.librarian]");
      expect(written).toContain("[mcp_servers.other]"); // other entries preserved
    });
  });

  it("uninstall: no-op when nothing is installed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      await expect(codex.uninstall()).resolves.toBeUndefined();
    });
  });
});
