// The `librarian` CLI runtime — a pure-ish function over argv.
//
// `runCli(argv, options)` returns `{ stdout, stderr, exitCode }` so the
// bin entry shapes it into a real process exit and tests assert against
// captured output without spawning a subprocess. `options.home` is
// injectable so tests run against a temp dir.
//
// This wave: `config`, `--help`, `--version` fully work. The
// harness-touching commands (install/uninstall/update/status) and the
// not-yet-built doctor/self-update/report route to placeholders that
// print "not yet implemented" — the orchestration logic lands next wave.

import { formatConfig, readConfig, redact, setConfig, type LibrarianConfig } from "./config.js";
import { detectShell, type Shell } from "./env.js";
import { allHarnesses } from "./harnesses/index.js";
import { flagString, parseArgs, type FlagMap } from "./parse-args.js";
import { cliVersion } from "./version.js";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RuntimeOptions {
  /** Override the home dir (tests). Defaults to the real `os.homedir()`. */
  home?: string;
  /** Override the detected shell (tests / `--shell`). */
  shell?: Shell;
}

const HARNESS_COMMANDS = new Set(["install", "uninstall", "update", "status"]);
const PLACEHOLDER_COMMANDS = new Set([
  "install",
  "uninstall",
  "update",
  "status",
  "doctor",
  "self-update",
  "report",
]);

export function runCli(argv: string[], options: RuntimeOptions = {}): CliResult {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return ok(usage());
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return ok(cliVersion());
  }

  if (command === "config") {
    return runConfig(rest, options);
  }

  if (PLACEHOLDER_COMMANDS.has(command)) {
    return runPlaceholder(command, rest);
  }

  return err(`Unknown command: ${command}\n\n${usage()}`);
}

// --- config (fully implemented) ------------------------------------------

function runConfig(rest: string[], options: RuntimeOptions): CliResult {
  const { flags } = parseArgs(rest);
  const mcpUrl = flagString(flags["mcp-url"]) ?? flagString(flags.url);
  const token = flagString(flags.token);
  const shell = options.shell ?? resolveShellFlag(flags);

  const wantsSet = mcpUrl !== undefined || token !== undefined;
  if (wantsSet) {
    const updated = setConfig({ mcpUrl, token }, { home: options.home, shell });
    // Confirm what changed WITHOUT echoing the token.
    return ok(["Updated config.", "", formatConfig(redact(updated))].join("\n"));
  }

  const current: LibrarianConfig | null = readConfig(options.home);
  if (!current) {
    return ok(
      [
        "No config set yet.",
        "",
        "Set it with:",
        "  librarian config --mcp-url <url> --token <token>",
      ].join("\n"),
    );
  }
  return ok(formatConfig(redact(current)));
}

function resolveShellFlag(flags: FlagMap): Shell | undefined {
  const raw = flagString(flags.shell);
  if (!raw) return undefined;
  return detectShell(raw);
}

// --- placeholders (logic lands in a later wave) --------------------------

function runPlaceholder(command: string, rest: string[]): CliResult {
  const { positionals } = parseArgs(rest);
  const scope =
    HARNESS_COMMANDS.has(command) && positionals.length > 0 ? ` (${positionals.join(", ")})` : "";
  return ok(`librarian ${command}${scope}: not yet implemented`);
}

// --- usage ---------------------------------------------------------------

export function usage(): string {
  const harnesses = allHarnesses.map((h) => h.id).join(", ");
  return [
    "Usage: librarian <command> [harness…] [flags]",
    "",
    "Commands:",
    "  install   [harness…]   Install The Librarian into one or more harnesses",
    "  uninstall [harness…]   Remove The Librarian from one or more harnesses",
    "  update    [harness…]   Update the integration to the current version",
    "  status                 Live table of harness / installed / version",
    "  doctor                 Diagnose token, server reachability, harness CLIs",
    "  config                 Show or set MCP URL, token, server URL",
    "  self-update            Update the librarian CLI itself",
    "  report                 Push this machine's state to the server",
    "",
    "Flags:",
    "  --mcp-url <url>        config: set the MCP endpoint URL",
    "  --token <token>        config: set the bearer token (never printed)",
    "  --shell <bash|zsh|fish>  override shell detection for the rc block",
    "  -h, --help            Show this help",
    "  -v, --version         Show the CLI version",
    "",
    `Harnesses: ${harnesses}`,
  ].join("\n");
}

// --- result helpers ------------------------------------------------------

function ok(stdout: string): CliResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function err(stderr: string): CliResult {
  return { stdout: "", stderr, exitCode: 1 };
}
