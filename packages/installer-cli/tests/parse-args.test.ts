// `parseArgs` — the installer CLI's arg parser (spec 073).
//
// Deliberately a sibling of packages/cli/parse-flags.ts, so the two must agree
// on what a flag looks like. Before this, `--data-dir=/srv/x` produced a junk
// flag literally named "data-dir=/srv/x" and left the real one unset, so a
// command ran with a default it was explicitly told not to use — silently.

import { describe, expect, it } from "vitest";
import { flagBool, flagString, parseArgs } from "../src/parse-args.js";

describe("parseArgs — the forms that already worked", () => {
  it("keeps positionals, bare switches, values, negation and repeats", () => {
    expect(parseArgs(["up", "--yes"])).toEqual({ positionals: ["up"], flags: { yes: true } });
    expect(parseArgs(["--data-dir", "/srv/x"]).flags["data-dir"]).toBe("/srv/x");
    expect(parseArgs(["--no-yes"]).flags.yes).toBe(false);
    expect(parseArgs(["--tag", "a", "--tag", "b"]).flags.tag).toEqual(["a", "b"]);
  });
});

describe("parseArgs — --flag=value", () => {
  it("reads an inline value instead of inventing a junk flag", () => {
    expect(parseArgs(["--data-dir=/srv/librarian"])).toEqual({
      positionals: [],
      flags: { "data-dir": "/srv/librarian" },
    });
  });

  it("splits on the first = only", () => {
    expect(flagString(parseArgs(["--token=a=b"]).flags.token)).toBe("a=b");
  });

  it("collects repeated inline values, like the spaced form", () => {
    expect(parseArgs(["--tag=a", "--tag=b"]).flags.tag).toEqual(["a", "b"]);
  });

  it("does not mistake an inline value for a positional", () => {
    expect(parseArgs(["up", "--data-dir=/srv/x"]).positionals).toEqual(["up"]);
  });

  // The installer has no switch registry, so `--yes=true` arrives as the STRING
  // "true". flagBool is the single reader of every switch here, so it is the
  // right place to make that mean what the operator plainly intended — without
  // it, `--yes=true` would read as false and silently prompt anyway.
  it("makes an inline switch value mean what it says", () => {
    expect(flagBool(parseArgs(["--yes=true"]).flags.yes)).toBe(true);
    expect(flagBool(parseArgs(["--yes=false"]).flags.yes)).toBe(false);
    expect(flagBool(parseArgs(["--yes=1"]).flags.yes)).toBe(true);
    expect(flagBool(parseArgs(["--yes=0"]).flags.yes)).toBe(false);
    expect(flagBool(parseArgs(["--yes"]).flags.yes)).toBe(true);
    expect(flagBool(parseArgs([]).flags.yes)).toBe(false);
  });
});
