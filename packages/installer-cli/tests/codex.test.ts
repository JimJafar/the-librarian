import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRunner, setRunner } from "../src/exec.js";
import { codex, resetCodexCaptureFetcher, setCodexCaptureFetcher } from "../src/harnesses/codex.js";
import {
  codexCaptureDir,
  codexConfigPath,
  codexHooksPath,
  resetHomeOverride,
  setHomeOverride,
} from "../src/paths.js";
import { FakeRunner, withTempHome } from "./helpers.js";

const CFG = {
  mcpUrl: "https://x.example/mcp",
  token: "secret-token-xyz",
  serverUrl: "https://x.example",
};

// Fixture dirs created per test, cleaned up afterwards.
const fixtureDirs: string[] = [];

/**
 * Build a throwaway fixture that mimics the fetched Codex integration tree
 * (scripts/ + hooks/codex-hooks.json) and register it as the capture fetcher so
 * install() never touches the network. The hooks template carries the same
 * ${LIBRARIAN_CODEX_ROOT} placeholder + owner marker the real one does. Registered
 * in a beforeEach so EVERY install() in this file is offline.
 */
function useFixtureCaptureFetcher(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-capture-fixture-"));
  fixtureDirs.push(root);
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "on-stop.mjs"), "// entry\n");
  fs.writeFileSync(path.join(root, "scripts", "lib", "capture.mjs"), "// lib\n");
  fs.writeFileSync(
    path.join(root, "hooks", "codex-hooks.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "${LIBRARIAN_CODEX_ROOT}/scripts/on-stop.mjs" # the-librarian-codex',
                timeout: 15,
              },
            ],
          },
        ],
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "${LIBRARIAN_CODEX_ROOT}/scripts/on-stop.mjs" # the-librarian-codex',
                timeout: 30,
              },
            ],
          },
        ],
      },
    }),
  );
  setCodexCaptureFetcher(async () => root);
  return root;
}

// Register the offline fixture fetcher before EVERY test so install() (which now
// wires both the MCP table AND the capture hooks) never reaches the network.
beforeEach(() => {
  useFixtureCaptureFetcher();
});

afterEach(() => {
  resetRunner();
  resetHomeOverride();
  resetCodexCaptureFetcher();
  while (fixtureDirs.length) {
    fs.rmSync(fixtureDirs.pop() as string, { recursive: true, force: true });
  }
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

// ── auto-capture hooks merger (spec 2026-06-16-harness-auto-capture, Phase 2A) ─
// install() wires the per-turn capture hooks into ~/.codex/hooks.json by MERGING
// our entries (idempotent via an owner marker), mirroring mem0's
// install_codex_hooks.py. The capture-adapter scripts are fetched from the pinned
// release (injected as a local fixture here) and copied under ~/.librarian/.

describe("codex auto-capture hooks merger (SC6)", () => {
  function readHooks(home: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(codexHooksPath(home), "utf8"));
  }

  it("install: copies the capture adapter scripts under ~/.librarian/codex-capture", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      useFixtureCaptureFetcher();
      await codex.install(CFG);
      expect(fs.existsSync(path.join(codexCaptureDir(home), "scripts", "on-stop.mjs"))).toBe(true);
    });
  });

  it("install: merges our hook entries into a NEW ~/.codex/hooks.json", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      useFixtureCaptureFetcher();
      await codex.install(CFG);
      const hooks = readHooks(home) as { hooks: Record<string, unknown[]> };
      expect(Object.keys(hooks.hooks)).toEqual(
        expect.arrayContaining(["UserPromptSubmit", "SessionEnd"]),
      );
      // The ${LIBRARIAN_CODEX_ROOT} placeholder is rewritten to the absolute
      // install path (no unexpanded placeholder remains in the merged file).
      const text = fs.readFileSync(codexHooksPath(home), "utf8");
      expect(text).toContain(codexCaptureDir(home));
      expect(text).not.toContain("${LIBRARIAN_CODEX_ROOT}");
      // The token VALUE never enters the hooks file.
      expect(text).not.toContain(CFG.token);
    });
  });

  it("install: preserves pre-existing foreign hook entries when merging", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      useFixtureCaptureFetcher();
      // Seed a foreign (e.g. mem0) hooks.json the user already has.
      fs.mkdirSync(path.dirname(codexHooksPath(home)), { recursive: true });
      fs.writeFileSync(
        codexHooksPath(home),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: "echo mem0 # mem0-plugin" }] },
            ],
            PreToolUse: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
          },
        }),
      );
      await codex.install(CFG);
      const text = fs.readFileSync(codexHooksPath(home), "utf8");
      // Foreign entries survive…
      expect(text).toContain("mem0-plugin");
      expect(text).toContain("echo foreign");
      // …and ours is added alongside.
      expect(text).toContain("the-librarian-codex");
    });
  });

  it("install: idempotent — a second install adds no duplicate owned entry", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      useFixtureCaptureFetcher();
      await codex.install(CFG);
      await codex.install(CFG);
      const text = fs.readFileSync(codexHooksPath(home), "utf8");
      const owned = (text.match(/the-librarian-codex/g) ?? []).length;
      const hooks = (readHooks(home) as { hooks: Record<string, unknown[]> }).hooks;
      // Exactly one owned entry per wired event (UserPromptSubmit + SessionEnd).
      expect(owned).toBe(2);
      expect(hooks.UserPromptSubmit).toHaveLength(1);
      expect(hooks.SessionEnd).toHaveLength(1);
    });
  });

  it("uninstall: strips ONLY our owned hook entries, preserving foreign ones", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      useFixtureCaptureFetcher();
      // Seed a foreign entry, then install ours on top.
      fs.mkdirSync(path.dirname(codexHooksPath(home)), { recursive: true });
      fs.writeFileSync(
        codexHooksPath(home),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
          },
        }),
      );
      await codex.install(CFG);
      await codex.uninstall();
      const text = fs.readFileSync(codexHooksPath(home), "utf8");
      expect(text).not.toContain("the-librarian-codex"); // ours gone
      expect(text).toContain("echo foreign"); // foreign preserved
      // The fetched adapter dir is removed.
      expect(fs.existsSync(codexCaptureDir(home))).toBe(false);
    });
  });

  it("a full install reports installed and leaves both the MCP table and the hook entry wired", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setRunner(new FakeRunner());
      useFixtureCaptureFetcher();
      await codex.install(CFG);
      const d = await codex.detect();
      expect(d.installed).toBe(true);
      expect(fs.readFileSync(codexConfigPath(home), "utf8")).toContain("[mcp_servers.librarian]");
      expect(fs.readFileSync(codexHooksPath(home), "utf8")).toContain("the-librarian-codex");
    });
  });
});
