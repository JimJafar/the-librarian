import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompter, MissingValueError, resolveSelection } from "../src/prompt.js";

const CHOICES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" },
];

/**
 * Reject (rather than hang the whole vitest run) if a prompt read never
 * settles — which is exactly the pre-fix failure mode for BUG 1: the second
 * read over a per-question readline never sees input and the await dangles.
 */
function withTimeout<T>(p: Promise<T>, label: string, ms = 1500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`prompt "${label}" never resolved (input lost)`)), ms),
    ),
  ]);
}

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

describe("createPrompter — real readline over fake streams (BUG 1 regression)", () => {
  it("captures BOTH a normal AND a following secret prompt over one shared input", async () => {
    // Drive the REAL prompter (no injected `prompt` fn) the way `resolveConfig`
    // does: ask for the MCP URL, then the secret token, in sequence, over a
    // single shared input stream that delivers BOTH lines in ONE chunk —
    // exactly what a piped/heredoc run (`librarian install <<EOF`) hands the
    // process. The pre-bug code built a fresh readline interface per question
    // and `rl.close()`d it; closing the first interface DISCARDED the buffered
    // remainder (`tok\n`), so the second `createInterface` saw no more input
    // and the token read hung forever — `resolveConfig` then threw "required".
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const p = createPrompter({ input, output, interactive: true });

    // Both answers arrive in ONE chunk on a pipe that stays open — exactly what
    // a paste or a fast piped run delivers. A single shared readline must hand
    // each buffered line to the right question; the first read can't be allowed
    // to swallow (or close away) the second's input.
    input.write("https://x/mcp\ntok\n");
    const url = await withTimeout(p.promptText("MCP URL"), "url");
    const token = await withTimeout(p.promptText("Agent token", { secret: true }), "token");

    expect(url).toBe("https://x/mcp");
    expect(token).toBe("tok");

    p.close();
  });

  it("a secret prompt keeps its label on screen (does not erase the prompt)", async () => {
    // The user's exact report: after entering the MCP URL, the "Agent token:"
    // prompt never appeared, so the next Enter sent an empty token and the run
    // errored "required". Root cause: the pre-fix secret path called
    // `rl.question("")`, whose terminal:true line-refresh emitted
    // `ESC[1G ESC[0J` (cursor-to-column-1 + erase-to-end-of-screen) right after
    // we'd written "Agent token: " directly — wiping the label off the screen.
    // The token was still CAPTURED, so the functional/mute tests stayed green
    // while the human saw a blank line. This asserts the missing invariant: no
    // erase sequence reaches the terminal, so the label the user must read to
    // know what to type survives. (Verified to fail on the old code and pass on
    // the fix; reproduces over a plain PassThrough because terminal:true is
    // forced, so a real PTY isn't needed.)
    const input = new PassThrough();
    const written: string[] = [];
    const output = new PassThrough();
    output.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    const p = createPrompter({ input, output, interactive: true });

    input.write("tok\n");
    await withTimeout(p.promptText("Agent token", { secret: true }), "token");
    const out = written.join("");

    expect(out).toContain("Agent token:"); // the label was emitted…
    expect(out).not.toContain("[0J"); // …and nothing erased to end-of-screen
    expect(out).not.toContain("[2K"); // …or cleared the prompt line

    p.close();
  });

  it("a secret prompt mutes the echo so the token never reaches the output stream", async () => {
    // A PassThrough left OPEN (never `.end()`ed) models a live TTY: the line is
    // available but the stream doesn't end, so readline doesn't auto-close.
    const input = new PassThrough();
    const written: string[] = [];
    const output = new PassThrough();
    output.on("data", (c: Buffer) => written.push(c.toString("utf8")));
    const p = createPrompter({ input, output, interactive: true });

    input.write("s3cr3t-token\n");
    const token = await withTimeout(p.promptText("Agent token", { secret: true }), "token");

    expect(token).toBe("s3cr3t-token");
    // The muted echo must keep the typed token out of what hit the terminal.
    expect(written.join("")).not.toContain("s3cr3t-token");

    p.close();
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
