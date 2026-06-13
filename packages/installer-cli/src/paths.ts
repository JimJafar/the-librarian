// Filesystem path resolution for the installer CLI.
//
// Everything the CLI persists lives under `~/.librarian/`. The home
// directory is *injectable* — every path helper takes an optional
// `home` argument that defaults to `os.homedir()`. Tests pass a temp
// dir so they never touch the real `~/.librarian`. Production code
// passes nothing and gets the real home.

import os from "node:os";
import path from "node:path";

// A module-level home override. The harness modules implement a fixed
// `HarnessModule` interface (no `home` param), so file-based harnesses
// (codex/opencode/hermes) resolve paths against this when set. Tests point
// it at a temp dir via `setHomeOverride`; production leaves it unset and
// gets the real `os.homedir()`.
let homeOverride: string | undefined;

/** Override the resolved home dir for every path helper (tests). */
export function setHomeOverride(home: string | undefined): void {
  homeOverride = home;
}

/** Clear the home override, restoring `os.homedir()` (tests). */
export function resetHomeOverride(): void {
  homeOverride = undefined;
}

/**
 * The user's home directory. An explicit `home` arg wins; then the
 * module-level override (tests); otherwise the real `os.homedir()`.
 */
export function homeDir(home?: string): string {
  return home ?? homeOverride ?? os.homedir();
}

/** `~/.librarian` — the root of everything the CLI persists. */
export function librarianDir(home?: string): string {
  return path.join(homeDir(home), ".librarian");
}

/** `~/.librarian/env` — the chmod-600 POSIX env file (bash/zsh source it). */
export function envFilePath(home?: string): string {
  return path.join(librarianDir(home), "env");
}

/** `~/.librarian/machine-id` — the dashboard's per-machine row key. */
export function machineIdPath(home?: string): string {
  return path.join(librarianDir(home), "machine-id");
}

/** `~/.config/fish/conf.d/librarian.fish` — fish's native env hook. */
export function fishConfPath(home?: string): string {
  return path.join(homeDir(home), ".config", "fish", "conf.d", "librarian.fish");
}

/** `~/.bashrc`. */
export function bashRcPath(home?: string): string {
  return path.join(homeDir(home), ".bashrc");
}

/** `~/.zshrc`. */
export function zshRcPath(home?: string): string {
  return path.join(homeDir(home), ".zshrc");
}

/** `~/.codex/config.toml` — Codex's MCP-server config. */
export function codexConfigPath(home?: string): string {
  return path.join(homeDir(home), ".codex", "config.toml");
}

/** `~/.config/opencode/opencode.json` — OpenCode's global config. */
export function opencodeConfigPath(home?: string): string {
  return path.join(homeDir(home), ".config", "opencode", "opencode.json");
}

/** `~/.hermes` — Hermes's home (plugins + config live under here). */
export function hermesHomeDir(home?: string): string {
  return path.join(homeDir(home), ".hermes");
}

/** `~/.hermes/plugins/librarian` — where the Hermes adapter is installed. */
export function hermesPluginDir(home?: string): string {
  return path.join(hermesHomeDir(home), "plugins", "librarian");
}

/** `~/.hermes/config.json` — Hermes config carrying `memory.provider`. */
export function hermesConfigPath(home?: string): string {
  return path.join(hermesHomeDir(home), "config.json");
}
