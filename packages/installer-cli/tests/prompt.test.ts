import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompter, MissingValueError, resolveSelection } from "../src/prompt.js";

const CHOICES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" },
];

describe("resolveSelection", () => {
  it("'all' / empty selects everything; 'none' selects nothing", () => {
    expect(resolveSelection("all", CHOICES)).toEqual(["claude", "codex", "pi"]);
    expect(resolveSelection("", CHOICES)).toEqual(["claude", "codex", "pi"]);
    expect(resolveSelection("none", CHOICES)).toEqual([]);
  });

  it("picks by 1-based number, ignoring out-of-range and dupes, preserving order", () => {
    expect(resolveSelection("1 3", CHOICES)).toEqual(["claude", "pi"]);
    expect(resolveSelection("3,1", CHOICES)).toEqual(["claude", "pi"]);
    expect(resolveSelection("2 2 9 0", CHOICES)).toEqual(["codex"]);
  });
});

describe("createPrompter — injected prompt fn", () => {
  it("promptText returns the answer; default fills an empty reply", async () => {
    const p = createPrompter({ prompt: async () => "" });
    expect(await p.promptText("Server", { default: "https://d" })).toBe("https://d");

    const p2 = createPrompter({ prompt: async () => "https://typed" });
    expect(await p2.promptText("Server", { default: "https://d" })).toBe("https://typed");
  });

  it("selectHarnesses parses the injected answer", async () => {
    const p = createPrompter({ prompt: async () => "1 3", output: new PassThrough() });
    expect(await p.selectHarnesses(CHOICES)).toEqual(["claude", "pi"]);
  });

  it("secret prompt passes the secret flag and never asks the fn to echo", async () => {
    let sawSecret = false;
    const p = createPrompter({
      prompt: async (_q, opts) => {
        sawSecret = opts.secret;
        return "tok";
      },
    });
    expect(await p.promptText("Token", { secret: true })).toBe("tok");
    expect(sawSecret).toBe(true);
  });
});

describe("createPrompter — non-interactive (no TTY)", () => {
  it("selectHarnesses falls back to all available", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = createPrompter({ input, output, interactive: false });
    expect(await p.selectHarnesses(CHOICES)).toEqual(["claude", "codex", "pi"]);
  });

  it("promptText returns the default, or errors clearly when none is set", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = createPrompter({ input, output, interactive: false });
    expect(await p.promptText("MCP URL", { default: "https://d" })).toBe("https://d");
    await expect(p.promptText("Agent token", { secret: true })).rejects.toBeInstanceOf(
      MissingValueError,
    );
  });
});
