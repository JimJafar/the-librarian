import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { opencode } from "../src/harnesses/opencode.js";
import { opencodeConfigPath, resetHomeOverride, setHomeOverride } from "../src/paths.js";
import { withTempHome } from "./helpers.js";

const CFG = {
  mcpUrl: "https://x.example/mcp",
  token: "secret-token-xyz",
  serverUrl: "https://x.example",
};

afterEach(() => resetHomeOverride());

function readJson(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(opencodeConfigPath(home), "utf8")) as Record<string, unknown>;
}

function seedJson(home: string, value: unknown): void {
  const file = opencodeConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

describe("opencode harness", () => {
  it("detect: not installed when config / mcp.librarian is absent", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await expect(opencode.detect()).resolves.toEqual({ installed: false });
      seedJson(home, { mcp: { other: { type: "remote" } } });
      await expect(opencode.detect()).resolves.toEqual({ installed: false });
    });
  });

  it("detect: installed + version from the managed marker", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await opencode.install(CFG);
      await expect(opencode.detect()).resolves.toEqual({ installed: true, version: "1.0.0" });
    });
  });

  it("install: writes the remote block with the env-var header (not the token)", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await opencode.install(CFG);
      const json = readJson(home);
      const block = (json.mcp as Record<string, Record<string, unknown>>).librarian;
      expect(block.type).toBe("remote");
      expect(block.url).toBe(CFG.mcpUrl);
      expect(block.enabled).toBe(true);
      expect((block.headers as Record<string, string>).Authorization).toBe(
        "Bearer {env:LIBRARIAN_AGENT_TOKEN}",
      );
      expect(json.instructions).toEqual(["https://x.example/primer.md"]);
      expect(JSON.stringify(json)).not.toContain(CFG.token);
    });
  });

  it("install: preserves existing keys and other mcp servers + instructions", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedJson(home, {
        $schema: "https://opencode.ai/config.json",
        mcp: { other: { type: "remote", url: "https://y/mcp" } },
        instructions: ["./AGENTS.md"],
        theme: "dark",
      });
      await opencode.install(CFG);
      const json = readJson(home);
      expect(json.$schema).toBe("https://opencode.ai/config.json");
      expect(json.theme).toBe("dark");
      expect((json.mcp as Record<string, unknown>).other).toBeDefined();
      expect((json.mcp as Record<string, unknown>).librarian).toBeDefined();
      expect(json.instructions).toEqual(["./AGENTS.md", "https://x.example/primer.md"]);
    });
  });

  it("install: idempotent — second run adds no duplicate instruction entry", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await opencode.install(CFG);
      await opencode.install(CFG);
      const json = readJson(home);
      expect(json.instructions).toEqual(["https://x.example/primer.md"]);
      expect(Object.keys(json.mcp as Record<string, unknown>)).toEqual(["librarian"]);
    });
  });

  it("uninstall: reverses install, preserving unrelated config", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedJson(home, {
        mcp: { other: { type: "remote", url: "https://y/mcp" } },
        instructions: ["./AGENTS.md"],
        theme: "dark",
      });
      await opencode.install(CFG);
      await opencode.uninstall();
      const json = readJson(home);
      expect((json.mcp as Record<string, unknown>).librarian).toBeUndefined();
      expect((json.mcp as Record<string, unknown>).other).toBeDefined();
      expect(json.instructions).toEqual(["./AGENTS.md"]); // our primer entry removed
      expect(json.theme).toBe("dark");
    });
  });

  it("uninstall: no-op when config is absent", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await expect(opencode.uninstall()).resolves.toBeUndefined();
      expect(fs.existsSync(opencodeConfigPath(home))).toBe(false);
    });
  });

  it("uninstall: removes ONLY our primer entry, leaving a foreign primer.md intact", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // A foreign instruction that happens to end in `/primer.md` but belongs
      // to some other tool / server — uninstall must NOT touch it.
      const foreign = "https://someone-else.example/primer.md";
      seedJson(home, { instructions: [foreign] });

      await opencode.install(CFG); // adds https://x.example/primer.md
      // Sanity: both present after install.
      expect(readJson(home).instructions).toEqual([foreign, "https://x.example/primer.md"]);

      await opencode.uninstall();

      const json = readJson(home);
      // OUR entry gone; the FOREIGN one survives.
      expect(json.instructions).toEqual([foreign]);
    });
  });
});
