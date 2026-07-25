// Parse-flags unit tests (T5.1).
//
// `parseFlags` is now its own module; these tests pin the contract
// before T5.2 starts importing it from per-verb command files. They
// cover the cases the end-to-end CLI tests touch only indirectly:
// repeated flags collecting into arrays, bare flags resolving to
// booleans, `--no-` negation, empty-string values, and the edge case
// where a bare flag is immediately followed by another flag.

import { describe, expect, it } from "vitest";
import {
  callerAgent,
  collectArray,
  flagString,
  parseFlags,
  parseNumber,
} from "../src/parse-flags.js";

describe("parseFlags", () => {
  it("returns positionals and an empty flag bag for plain args", () => {
    expect(parseFlags(["a", "b", "c"])).toEqual({
      positionals: ["a", "b", "c"],
      flags: {},
    });
  });

  it("treats `--foo bar` as a string-valued flag", () => {
    const result = parseFlags(["--title", "Hello"]);
    expect(result.flags.title).toBe("Hello");
  });

  it("collects repeated `--foo` flags into an array preserving order", () => {
    const result = parseFlags(["--tag", "a", "--tag", "b", "--tag", "c"]);
    expect(result.flags.tag).toEqual(["a", "b", "c"]);
  });

  it("resolves a bare `--foo` to `true` when the next arg is another flag", () => {
    const result = parseFlags(["--agent", "--json"]);
    expect(result.flags.agent).toBe(true);
    expect(result.flags.json).toBe(true);
  });

  it("resolves `--no-foo` to `false`", () => {
    const result = parseFlags(["--no-attach", "--no-pretty"]);
    expect(result.flags.attach).toBe(false);
    expect(result.flags.pretty).toBe(false);
  });

  it("accepts an empty-string value as a string flag", () => {
    const result = parseFlags(["--title", ""]);
    expect(result.flags.title).toBe("");
  });

  it("keeps positionals positional when mixed with flags", () => {
    const result = parseFlags(["ses_123", "--agent", "bede", "--summary", "ok"]);
    expect(result.positionals).toEqual(["ses_123"]);
    expect(result.flags).toEqual({ agent: "bede", summary: "ok" });
  });
});

describe("collectArray", () => {
  it("returns [] for undefined / boolean values", () => {
    expect(collectArray(undefined)).toEqual([]);
    expect(collectArray(true)).toEqual([]);
    expect(collectArray(false)).toEqual([]);
  });

  it("wraps a single string in an array", () => {
    expect(collectArray("solo")).toEqual(["solo"]);
  });

  it("passes an array through unchanged", () => {
    expect(collectArray(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("parseNumber", () => {
  it("returns undefined for missing / non-numeric inputs", () => {
    expect(parseNumber(undefined)).toBeUndefined();
    expect(parseNumber(true)).toBeUndefined();
    expect(parseNumber(["1"])).toBeUndefined();
    expect(parseNumber("oops")).toBeUndefined();
  });

  it("parses numeric strings", () => {
    expect(parseNumber("42")).toBe(42);
    expect(parseNumber("0")).toBe(0);
  });
});

describe("callerAgent", () => {
  it("returns the --agent flag when it's a non-empty string", () => {
    expect(callerAgent({ agent: "bede" })).toBe("bede");
  });

  it("falls back to $LIBRARIAN_AGENT_ID when --agent is bare (true)", () => {
    const previous = process.env.LIBRARIAN_AGENT_ID;
    process.env.LIBRARIAN_AGENT_ID = "envtest";
    try {
      expect(callerAgent({ agent: true })).toBe("envtest");
    } finally {
      if (previous === undefined) delete process.env.LIBRARIAN_AGENT_ID;
      else process.env.LIBRARIAN_AGENT_ID = previous;
    }
  });

  it("falls back to 'cli' when no flag and no env are set", () => {
    const previous = process.env.LIBRARIAN_AGENT_ID;
    delete process.env.LIBRARIAN_AGENT_ID;
    try {
      expect(callerAgent({})).toBe("cli");
    } finally {
      if (previous !== undefined) process.env.LIBRARIAN_AGENT_ID = previous;
    }
  });

  it("canonicalises the --agent flag to naming-contract form", () => {
    expect(callerAgent({ agent: "Guybrush" })).toBe("guybrush");
    expect(callerAgent({ agent: "Claude Code" })).toBe("claude-code");
    expect(callerAgent({ agent: "Guybrush (Hermes)" })).toBe("guybrush-hermes");
  });

  it("canonicalises $LIBRARIAN_AGENT_ID too", () => {
    const previous = process.env.LIBRARIAN_AGENT_ID;
    process.env.LIBRARIAN_AGENT_ID = "Codex";
    try {
      expect(callerAgent({ agent: true })).toBe("codex");
    } finally {
      if (previous === undefined) delete process.env.LIBRARIAN_AGENT_ID;
      else process.env.LIBRARIAN_AGENT_ID = previous;
    }
  });

  it("throws on a --agent value that has no canonical form", () => {
    expect(() => callerAgent({ agent: "!!!" })).toThrow(/empty/i);
  });

  it("keeps the cli default valid (the one allowed reserved id)", () => {
    expect(callerAgent({ agent: "CLI" })).toBe("cli");
  });

  it("rejects an operator claiming a reserved system/dashboard id", () => {
    expect(() => callerAgent({ agent: "system-memory-curator" })).toThrow(/reserved/i);
    expect(() => callerAgent({ agent: "dashboard-admin" })).toThrow(/reserved/i);
  });
});

describe("flagString", () => {
  it("returns the value only when it's a string", () => {
    expect(flagString("hi")).toBe("hi");
    expect(flagString(true)).toBeUndefined();
    expect(flagString(false)).toBeUndefined();
    expect(flagString(["a"])).toBeUndefined();
    expect(flagString(undefined)).toBeUndefined();
  });
});

// Known-boolean flags (spec 073, after the `--move` trap).
//
// The parser gives a flag the FOLLOWING argument as its value whenever that
// argument isn't another flag. For a value flag (`--data-dir <path>`) that is
// exactly right. For a boolean it is a trap: `--move ./a.md` parsed as
// `{ move: "./a.md" }` with NO positional, so the command saw no path at all.
//
// Every boolean flag in the CLI had this latent — `--force`, `--admin`,
// `--json`, `--include-claimed`, `--print-setup-link` — and each was safe only
// by the convention of writing it last. Flag order should not be load-bearing,
// so the parser now knows which names are boolean.
describe("parseFlags — known boolean flags never swallow the next argument", () => {
  it("leaves a following positional alone for --move", () => {
    expect(parseFlags(["--move", "./a.md"])).toEqual({
      positionals: ["./a.md"],
      flags: { move: true },
    });
  });

  it.each(["force", "admin", "json", "include-claimed", "print-setup-link", "move"])(
    "treats --%s as boolean wherever it appears",
    (name) => {
      const before = parseFlags([`--${name}`, "positional"]);
      expect(before.flags[name]).toBe(true);
      expect(before.positionals).toEqual(["positional"]);

      const after = parseFlags(["positional", `--${name}`]);
      expect(after.flags[name]).toBe(true);
      expect(after.positionals).toEqual(["positional"]);
    },
  );

  it("still lets --no-<boolean> mean false", () => {
    expect(parseFlags(["--no-json", "positional"])).toEqual({
      positionals: ["positional"],
      flags: { json: false },
    });
  });

  it("does NOT change value flags — they still consume their argument", () => {
    expect(parseFlags(["--data-dir", "/tmp/x"])).toEqual({
      positionals: [],
      flags: { "data-dir": "/tmp/x" },
    });
    expect(parseFlags(["--secret-key", "abc", "positional"])).toEqual({
      positionals: ["positional"],
      flags: { "secret-key": "abc" },
    });
  });

  it("keeps a boolean boolean even when several are chained with positionals", () => {
    const result = parseFlags(["list", "--json", "--limit", "5", "--include-claimed", "extra"]);
    expect(result.flags.json).toBe(true);
    expect(result.flags.limit).toBe("5");
    expect(result.flags["include-claimed"]).toBe(true);
    expect(result.positionals).toEqual(["list", "extra"]);
  });
});
