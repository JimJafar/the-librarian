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

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    if (arg.startsWith("--no-")) {
      flags[arg.slice("--no-".length)] = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
        flags[key] = true;
      } else {
        const existing = flags[key];
        if (existing === undefined) {
          flags[key] = next;
        } else if (Array.isArray(existing)) {
          existing.push(next);
        } else if (typeof existing === "string") {
          flags[key] = [existing, next];
        } else {
          flags[key] = next;
        }
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

/** True iff the flag was passed as a bare boolean (`--foo`) or set truthy. */
export function flagBool(value: FlagValue | undefined): boolean {
  return value === true;
}
