import { afterEach, describe, expect, it } from "vitest";
import { resetRunner, setRunner } from "../src/exec.js";
import { claude } from "../src/harnesses/claude.js";
import { FakeRunner } from "./helpers.js";

const CFG = {
  mcpUrl: "https://x.example/mcp",
  token: "secret-token-xyz",
  serverUrl: "https://x.example",
};

afterEach(() => resetRunner());

describe("claude harness", () => {
  it("detect: not installed when `claude` is absent from PATH", async () => {
    setRunner(new FakeRunner()); // no withWhich → not present
    await expect(claude.detect()).resolves.toEqual({ installed: false });
  });

  it("detect: not installed when CLI is present but plugin not listed", async () => {
    setRunner(
      new FakeRunner().withWhich("claude").onRun("claude", ["plugin", "list"], {
        stdout: "Installed plugins:\n  some-other-plugin@market 1.2.3\n",
      }),
    );
    await expect(claude.detect()).resolves.toEqual({ installed: false });
  });

  it("detect: installed + version parsed from `plugin list`", async () => {
    setRunner(
      new FakeRunner().withWhich("claude").onRun("claude", ["plugin", "list"], {
        stdout: "Installed plugins:\n  the-librarian@the-librarian  v1.0.0-rc.2 (enabled)\n",
      }),
    );
    await expect(claude.detect()).resolves.toEqual({ installed: true, version: "1.0.0-rc.2" });
  });

  it("detect: installed with undefined version when none parseable", async () => {
    setRunner(
      new FakeRunner().withWhich("claude").onRun("claude", ["plugin", "list"], {
        stdout: "  the-librarian@the-librarian (enabled)\n",
      }),
    );
    await expect(claude.detect()).resolves.toEqual({ installed: true });
  });

  it("install: marketplace add then plugin install, with the right ids", async () => {
    const r = new FakeRunner().withWhich("claude");
    setRunner(r);
    await claude.install(CFG);
    expect(r.ran("claude", ["plugin", "marketplace", "add", "JimJafar/the-librarian"])).toBe(true);
    expect(r.ran("claude", ["plugin", "install", "the-librarian@the-librarian"])).toBe(true);
  });

  it("install: throws a friendly error when `claude` is not on PATH", async () => {
    setRunner(new FakeRunner());
    await expect(claude.install(CFG)).rejects.toThrow(/Claude Code CLI not found on PATH/);
  });

  it("uninstall: removes the plugin then the marketplace; no-op when CLI absent", async () => {
    const r = new FakeRunner().withWhich("claude");
    setRunner(r);
    await claude.uninstall();
    expect(r.ran("claude", ["plugin", "remove", "the-librarian@the-librarian"])).toBe(true);
    expect(r.ran("claude", ["plugin", "marketplace", "remove", "the-librarian"])).toBe(true);

    const empty = new FakeRunner();
    setRunner(empty);
    await expect(claude.uninstall()).resolves.toBeUndefined();
    expect(empty.calls.filter((c) => c.cmd === "claude")).toHaveLength(0);
  });

  it("never logs or passes the token anywhere", async () => {
    const r = new FakeRunner().withWhich("claude");
    setRunner(r);
    await claude.install(CFG);
    const serialized = JSON.stringify(r.calls);
    expect(serialized).not.toContain(CFG.token);
  });
});
