// CLI flag parser + small input helpers.
//
// `parseFlags` accepts `argv` slices (everything after the verb) and
// produces a `{ positionals, flags }` object. Repeated flags collect
// into arrays (e.g. `--tag a --tag b` → `flags.tag = ["a", "b"]`).
// Bare `--foo` flags resolve to `true`; `--no-foo` to `false`.
//
// The other helpers turn the loose flag bag into the typed shapes the
// store APIs expect — array coercion, optional number parsing, the
// caller-agent fallback, and `--summary` / `--summary-file` resolution.

import fs from "node:fs";
import { isReservedId, normaliseCallerId } from "@librarian/core";

export type FlagValue = string | boolean | string[];
export type FlagMap = Record<string, FlagValue>;

export interface ParsedArgs {
  positionals: string[];
  flags: FlagMap;
}

/**
 * Flags that are switches, never values.
 *
 * Without this the parser hands a flag the FOLLOWING argument as its value
 * whenever that argument isn't another flag. For a value flag
 * (`--data-dir <path>`) that is exactly right; for a switch it is a trap —
 * `refs add --move ./a.md` parsed as `{ move: "./a.md" }` with NO positional at
 * all, so the command saw no path and printed usage instead.
 *
 * Every switch in this CLI had that latent, and each was safe only by the
 * convention of writing it last. Flag ORDER should not be load-bearing, so the
 * parser is told which names are switches.
 *
 * Add new switches here. One that is missing silently regains the old
 * swallow-the-next-argument behaviour, which is why the list lives beside the
 * parser rather than in each command.
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "admin",
  "force",
  "include-claimed",
  "json",
  "move",
  "print-setup-link",
]);

export function parseFlags(args: string[]): ParsedArgs {
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
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue; // a switch never consumes the following argument
      }
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

export function collectArray(value: FlagValue | undefined): string[] {
  if (value == null || value === true || value === false) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

export function parseNumber(value: FlagValue | undefined): number | undefined {
  if (value == null || value === true || value === false) return undefined;
  if (Array.isArray(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function callerAgent(flags: FlagMap): string {
  // The CLI is a trusted local boundary (no token), so we only canonicalise
  // the caller id — `--agent "Guybrush"` → `guybrush` — keeping CLI attribution
  // consistent with the MCP boundary. A value with no canonical form throws,
  // surfacing as a clean CLI error via the runtime's try/catch. Manual operator
  // calls default to the `cli` actor.
  const agent = flags.agent;
  const raw =
    typeof agent === "string" && agent.length ? agent : process.env.LIBRARIAN_AGENT_ID || "cli";
  const id = normaliseCallerId(raw);
  // `cli` is the only reserved id valid at this boundary (§4.4). Block an
  // operator from writing attribution as a system/dashboard actor, while still
  // allowing the `cli` default and ordinary agent ids.
  if (isReservedId(id) && id !== "cli") {
    throw new Error(`agent id "${id}" is reserved and cannot be used from the CLI`);
  }
  return id;
}

export function readSummary(flags: FlagMap): string | null {
  if (typeof flags.summary === "string") return flags.summary;
  const file = flags["summary-file"];
  if (typeof file === "string" && file.length) {
    return fs.readFileSync(file, "utf8").trimEnd();
  }
  return null;
}

export function flagString(value: FlagValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
