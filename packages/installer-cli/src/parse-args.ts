// A tiny dependency-light arg parser, matching the repo's lean style
// (see packages/cli/src/parse-flags.ts). No framework.
//
// `parseArgs(argv)` splits a verb's arguments into `{ positionals, flags }`.
// Bare `--foo` → `true`; `--no-foo` → `false`; `--foo bar` → `"bar"`;
// repeated `--foo a --foo b` → `["a", "b"]`.

export type FlagValue = string | boolean | string[];
export type FlagMap = Record<string, FlagValue>;

export interface ParsedArgs {
  positionals: string[];
  flags: FlagMap;
}

/**
 * Record a flag value, collecting repeats into an array. Shared by the spaced
 * (`--tag a`) and inline (`--tag=a`) forms so the two cannot drift.
 */
function assignFlag(flags: FlagMap, key: string, value: string): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else if (typeof existing === "string") {
    flags[key] = [existing, value];
  } else {
    flags[key] = value;
  }
}

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    if (arg.startsWith("--")) {
      // Split `--key=value` on the FIRST `=` (spec 073). Without this the whole
      // `key=value` string became the flag NAME set to true, leaving the real
      // flag unset — so `--data-dir=/srv/x` ran against the default without a
      // word. Mirrors packages/cli/parse-flags.ts; the two must agree on what a
      // flag looks like.
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      const key = equals === -1 ? body : body.slice(0, equals);
      const inlineValue = equals === -1 ? null : body.slice(equals + 1);

      if (key.startsWith("no-")) {
        flags[key.slice("no-".length)] = false;
        continue;
      }
      if (inlineValue !== null) {
        assignFlag(flags, key, inlineValue);
        continue;
      }
      const next = args[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
        flags[key] = true;
      } else {
        assignFlag(flags, key, next);
        i += 1;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

/** Coerce a flag to a string, or undefined when it isn't a plain string. */
export function flagString(value: FlagValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * True iff the flag reads as on: a bare `--foo`, or an inline `--foo=true`.
 *
 * The inline arm matters because this parser has no switch registry, so
 * `--yes=true` arrives as the STRING "true" (spec 073). Comparing to `true`
 * alone would read that as off and silently prompt anyway — the operator having
 * plainly said otherwise. `flagBool` is the single reader of every switch here,
 * so this is the one place the interpretation belongs.
 */
export function flagBool(value: FlagValue | undefined): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return !(
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === ""
  );
}
