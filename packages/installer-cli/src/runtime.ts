// The `librarian` CLI runtime — an async function over argv.
//
// `runCli(argv, options)` resolves to `{ stdout, stderr, exitCode }` so the
// bin entry shapes it into a real process exit and tests assert against
// captured output without spawning a subprocess. Everything that touches the
// system is injectable through `options`: `home` (temp dir), `shell`, a
// `prompter` (prompt answers), and the per-module seams the commands pull in
// (`setRunner` / `setHomeOverride` / `setAdapterFetcher` / `setLatestFetcher`
// / `setServerProbe`). NOTHING here touches the real system, network, or
// stdin in tests.

import { runInstall } from "./commands/install.js";
import { runUninstall } from "./commands/uninstall.js";
import { runUpdate } from "./commands/update.js";
import { formatConfig, readConfig, redact, setConfig, type LibrarianConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { detectShell, type Shell } from "./env.js";
import { allHarnesses } from "./harnesses/index.js";
import { flagString, parseArgs, type FlagMap } from "./parse-args.js";
import { createPrompter, MissingValueError, type Prompter } from "./prompt.js";
import { status } from "./status.js";
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
  /** Inject a prompter (tests). Defaults to a real stdio-backed prompter. */
  prompter?: Prompter;
  /**
   * The process environment to read existing `LIBRARIAN_*` vars from (BUG 2).
   * Injectable so tests never touch the real `process.env` and never log a
   * token. Defaults to `process.env` in `runInstall`.
   */
  env?: NodeJS.ProcessEnv;
}

const PHASE_2_STUBS = new Set(["report", "self-update"]);

/**
 * The CLI entrypoint. Dispatches to the command handlers and — crucially —
 * turns any escaped error into one clean stderr line + exit 1, so a failure
 * never leaks a stack trace into the user's terminal (house rule: "never
 * leak a stack trace"). `MissingValueError` (a required prompt with no value
 * in a non-interactive run) gets a specific, actionable message.
 */
export async function runCli(argv: string[], options: RuntimeOptions = {}): Promise<CliResult> {
  try {
    return await dispatch(argv, options);
  } catch (error) {
    if (error instanceof MissingValueError) {
      return err(
        "MCP URL and token are required — re-run interactively, or pass --mcp-url/--token.",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(`librarian: ${message}`);
  }
}

async function dispatch(argv: string[], options: RuntimeOptions): Promise<CliResult> {
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

  if (command === "install") {
    return runInstallCommand(rest, options);
  }
  if (command === "uninstall") {
    return runUninstallCommand(rest, options);
  }
  if (command === "update") {
    return runUpdateCommand(rest, options);
  }
  if (command === "status") {
    return ok(await status(options.home));
  }
  if (command === "doctor") {
    // Diagnostic: exits 0 even when it flags problems.
    return ok(await doctor(options.home));
  }

  if (PHASE_2_STUBS.has(command)) {
    return runPhase2Stub(command);
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

// --- harness-touching commands -------------------------------------------

async function runInstallCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { positionals, flags } = parseArgs(rest);
  const shell = options.shell ?? resolveShellFlag(flags);
  const prompter = options.prompter ?? createPrompter();
  try {
    const outcome = await runInstall(positionals, {
      home: options.home,
      shell,
      prompter,
      env: options.env,
    });
    // A mid-install failure makes the command non-zero so scripts notice; a
    // pure skip (CLI absent) is a success.
    return outcome.failed.length > 0 ? errOut(outcome.output) : ok(outcome.output);
  } finally {
    // Tear down the shared readline (BUG 1) so an open interface doesn't keep
    // the event loop alive and hang the process after the command completes.
    prompter.close();
  }
}

async function runUninstallCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { positionals, flags } = parseArgs(rest);
  const shell = options.shell ?? resolveShellFlag(flags);
  const prompter = options.prompter ?? createPrompter();
  try {
    const outcome = await runUninstall(positionals, { home: options.home, shell, prompter });
    return outcome.failed.length > 0 ? errOut(outcome.output) : ok(outcome.output);
  } finally {
    prompter.close();
  }
}

async function runUpdateCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { positionals } = parseArgs(rest);
  const outcome = await runUpdate(positionals, { home: options.home });
  return outcome.failed.length > 0 ? errOut(outcome.output) : ok(outcome.output);
}

// --- Phase 2 stubs (friendly "coming later") -----------------------------

function runPhase2Stub(command: string): CliResult {
  const detail =
    command === "report"
      ? "Server reporting (the dashboard's Installs view) arrives in a later release."
      : "Self-update of the CLI arrives in a later release. For now: `npm i -g @the-librarian/cli`.";
  return ok(`librarian ${command}: coming in a later release.\n\n${detail}`);
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

/** A non-zero result that still carries its (already-formatted) report on stdout. */
function errOut(stdout: string): CliResult {
  return { stdout, stderr: "", exitCode: 1 };
}
