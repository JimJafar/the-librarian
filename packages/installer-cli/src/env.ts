// Env-var plumbing: `~/.librarian/env` + the managed shell-rc block.
//
// The token and MCP URL never land in a committed or world-readable rc.
// We write them to `~/.librarian/env` (chmod 600) and add ONE idempotent
// managed block to the user's shell rc that sources it:
//
//   # >>> librarian >>>
//   [ -f "$HOME/.librarian/env" ] && . "$HOME/.librarian/env"
//   # <<< librarian <<<
//
// Re-running REPLACES the block (matched on the sentinels) — never
// duplicates. Fish can't source a POSIX env file, so it gets a native
// `~/.config/fish/conf.d/librarian.fish` with `set -gx` reading the same
// values. The token is never logged.
//
// Every function takes an injectable `home` so tests run against a temp
// dir; nothing here touches the real `~`.

import fs from "node:fs";
import path from "node:path";
import { bashRcPath, envFilePath, fishConfPath, librarianDir, zshRcPath } from "./paths.js";

/** The secrets the env file carries. */
export interface EnvValues {
  mcpUrl: string;
  token: string;
}

export type Shell = "bash" | "zsh" | "fish";

// The exact sentinels the spec pins. The block is matched on these so a
// re-run replaces it rather than appending a duplicate. Do not reword.
const BLOCK_OPEN = "# >>> librarian >>>";
const BLOCK_CLOSE = "# <<< librarian <<<";
const POSIX_SOURCE_LINE = '[ -f "$HOME/.librarian/env" ] && . "$HOME/.librarian/env"';

const FISH_OPEN = "# >>> librarian >>>";
const FISH_CLOSE = "# <<< librarian <<<";

/**
 * Detect the user's shell from `$SHELL`, defaulting to bash.
 *
 * `override` (e.g. from a `--shell` flag) wins when it names a supported
 * shell. An unrecognised `$SHELL` falls back to bash — the POSIX block
 * is the safe default.
 */
export function detectShell(override?: string, env: NodeJS.ProcessEnv = process.env): Shell {
  const pick = (value: string | undefined): Shell | undefined => {
    if (!value) return undefined;
    const base = value.toLowerCase();
    if (base.includes("fish")) return "fish";
    if (base.includes("zsh")) return "zsh";
    if (base.includes("bash")) return "bash";
    return undefined;
  };
  return pick(override) ?? pick(env.SHELL) ?? "bash";
}

/**
 * Write `~/.librarian/env` with the two exports, chmod 600.
 *
 * The directory is created if missing; the file is (re)written wholesale
 * so stale values can't linger. Never logs `values.token`.
 */
export function writeEnvFile(values: EnvValues, home?: string): void {
  const dir = librarianDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    `export LIBRARIAN_MCP_URL=${shellQuote(values.mcpUrl)}`,
    `export LIBRARIAN_AGENT_TOKEN=${shellQuote(values.token)}`,
    "",
  ].join("\n");
  const file = envFilePath(home);
  fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
  // writeFileSync only applies `mode` on create; chmod unconditionally so a
  // pre-existing looser file is tightened.
  fs.chmodSync(file, 0o600);
}

/** Read the env file back into structured values, or null if absent. */
export function readEnvFile(home?: string): EnvValues | null {
  let raw: string;
  try {
    raw = fs.readFileSync(envFilePath(home), "utf8");
  } catch {
    return null;
  }
  const mcpUrl = parseExport(raw, "LIBRARIAN_MCP_URL");
  const token = parseExport(raw, "LIBRARIAN_AGENT_TOKEN");
  if (mcpUrl === undefined && token === undefined) return null;
  return { mcpUrl: mcpUrl ?? "", token: token ?? "" };
}

/**
 * Apply (or replace) the managed block in the shell rc.
 *
 * For bash/zsh this writes the POSIX source-block into `~/.bashrc` or
 * `~/.zshrc`. For fish it writes `~/.config/fish/conf.d/librarian.fish`
 * with `set -gx` reading the values directly (fish can't source POSIX).
 *
 * Idempotent: a second call with the rc already containing a block
 * replaces it in place — never appends a duplicate.
 *
 * Returns the path that was written.
 */
export function applyShellBlock(shell: Shell, values: EnvValues, home?: string): string {
  if (shell === "fish") return writeFishConf(values, home);
  const rcPath = shell === "zsh" ? zshRcPath(home) : bashRcPath(home);
  const block = [BLOCK_OPEN, POSIX_SOURCE_LINE, BLOCK_CLOSE].join("\n");
  const next = upsertBlock(readFileOrEmpty(rcPath), block);
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  fs.writeFileSync(rcPath, next, { encoding: "utf8" });
  return rcPath;
}

/** Remove the managed block from the shell rc (or delete the fish conf). */
export function removeShellBlock(shell: Shell, home?: string): void {
  if (shell === "fish") {
    try {
      fs.rmSync(fishConfPath(home));
    } catch {
      // already gone
    }
    return;
  }
  const rcPath = shell === "zsh" ? zshRcPath(home) : bashRcPath(home);
  const current = readFileOrEmpty(rcPath);
  if (!current) return;
  const stripped = stripBlock(current);
  if (stripped !== current) fs.writeFileSync(rcPath, stripped, { encoding: "utf8" });
}

function writeFishConf(values: EnvValues, home?: string): string {
  const confPath = fishConfPath(home);
  const body = [
    FISH_OPEN,
    `set -gx LIBRARIAN_MCP_URL ${fishQuote(values.mcpUrl)}`,
    `set -gx LIBRARIAN_AGENT_TOKEN ${fishQuote(values.token)}`,
    FISH_CLOSE,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(confPath), { recursive: true });
  // The fish conf carries the token directly, so tighten it to 600 too.
  fs.writeFileSync(confPath, body, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(confPath, 0o600);
  return confPath;
}

// --- block manipulation (sentinel-matched, idempotent) -------------------

/** Replace an existing sentinel block, or append a fresh one. */
function upsertBlock(content: string, block: string): string {
  const stripped = stripBlock(content);
  const base = stripped.length === 0 || stripped.endsWith("\n") ? stripped : `${stripped}\n`;
  return `${base}${block}\n`;
}

/** Remove a sentinel-delimited block (and its surrounding blank lines). */
function stripBlock(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === BLOCK_OPEN);
  if (start === -1) return content;
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === BLOCK_CLOSE) {
      end = i;
      break;
    }
  }
  if (end === -1) return content; // unterminated — leave it alone
  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  // Drop a single trailing blank line left by the block so repeated
  // apply/strip cycles don't accumulate whitespace.
  while (before.length > 0 && before[before.length - 1] === "") before.pop();
  while (after.length > 0 && after[0] === "") after.shift();
  const joined = [...before, ...after].join("\n");
  return joined;
}

// --- small helpers -------------------------------------------------------

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function parseExport(raw: string, name: string): string | undefined {
  // Matches `export NAME=value` (value optionally single/double quoted).
  const re = new RegExp(`^\\s*export\\s+${name}=(.*)$`, "m");
  const match = re.exec(raw);
  if (!match) return undefined;
  return unquote((match[1] ?? "").trim());
}

/** POSIX single-quote a value so the env file is robust to special chars. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Fish single-quote a value (fish escapes `\` and `'` inside single quotes). */
function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
