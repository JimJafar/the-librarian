import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  opencode,
  resetOpencodeCaptureFetcher,
  setOpencodeCaptureFetcher,
} from "../src/harnesses/opencode.js";
import {
  opencodeCaptureDir,
  opencodeConfigPath,
  resetHomeOverride,
  setHomeOverride,
} from "../src/paths.js";
import { withTempHome } from "./helpers.js";

const CFG = {
  mcpUrl: "https://x.example/mcp",
  token: "secret-token-xyz",
  serverUrl: "https://x.example",
};

// Fixture dirs created per test, cleaned up afterwards.
const fixtureDirs: string[] = [];

/**
 * Build a throwaway fixture mimicking the fetched OpenCode integration tree
 * (a `plugin/` dir holding the entry + its `.mjs` lib) and register it as the
 * capture fetcher so install() never touches the network. Mirrors the Codex
 * `useFixtureCaptureFetcher` in codex.test.ts.
 */
function useFixtureCaptureFetcher(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-capture-fixture-"));
  fixtureDirs.push(root);
  fs.mkdirSync(path.join(root, "plugin", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugin", "librarian-capture.ts"), "// entry\n");
  fs.writeFileSync(path.join(root, "plugin", "lib", "capture.mjs"), "// lib\n");
  setOpencodeCaptureFetcher(async () => root);
  return root;
}

// Register the offline fixture fetcher before EVERY test so install() (which now
// also wires the per-turn capture plugin) never reaches the network.
beforeEach(() => {
  useFixtureCaptureFetcher();
});

afterEach(() => {
  resetHomeOverride();
  resetOpencodeCaptureFetcher();
  while (fixtureDirs.length) {
    const dir = fixtureDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

// ── auto-capture plugin wiring (spec 2026-06-16-harness-auto-capture, Phase 2A) ─
// install() now ALSO installs the per-turn capture plugin: it fetches the OpenCode
// integration's `plugin/` tree (pinned release tarball) into
// ~/.librarian/opencode-capture and registers the entry in opencode.json's
// `plugin` array so OpenCode loads it. The fetch is offline here (fixture fetcher).
describe("opencode auto-capture plugin wiring (SC6)", () => {
  function pluginEntryPath(home: string): string {
    return path.join(opencodeCaptureDir(home), "plugin", "librarian-capture.ts");
  }

  it("install: copies the capture plugin tree under ~/.librarian/opencode-capture", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await opencode.install(CFG);
      expect(fs.existsSync(pluginEntryPath(home))).toBe(true);
      expect(
        fs.existsSync(path.join(opencodeCaptureDir(home), "plugin", "lib", "capture.mjs")),
      ).toBe(true);
    });
  });

  it("install: registers the entry's absolute path in opencode.json's plugin array", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await opencode.install(CFG);
      const json = readJson(home);
      expect(json.plugin).toEqual([pluginEntryPath(home)]);
    });
  });

  it("install: idempotent — a second run adds no duplicate plugin entry", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await opencode.install(CFG);
      await opencode.install(CFG);
      const json = readJson(home);
      expect(json.plugin).toEqual([pluginEntryPath(home)]);
    });
  });

  it("install: preserves a foreign plugin already in the array", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedJson(home, { plugin: ["@someone/other-plugin"] });
      await opencode.install(CFG);
      const json = readJson(home);
      expect(json.plugin).toEqual(["@someone/other-plugin", pluginEntryPath(home)]);
    });
  });

  it("uninstall: removes ONLY our plugin entry + the capture dir, leaving foreigners", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      seedJson(home, { plugin: ["@someone/other-plugin"] });
      await opencode.install(CFG);
      expect(fs.existsSync(opencodeCaptureDir(home))).toBe(true);

      await opencode.uninstall();

      const json = readJson(home);
      expect(json.plugin).toEqual(["@someone/other-plugin"]); // ours gone, foreign kept
      expect(fs.existsSync(opencodeCaptureDir(home))).toBe(false); // scripts removed
    });
  });

  it('uninstall: drops an emptied plugin array (no `{"plugin":[]}` litter)', async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await opencode.install(CFG);
      await opencode.uninstall();
      const json = readJson(home);
      expect(json.plugin).toBeUndefined();
    });
  });
});
