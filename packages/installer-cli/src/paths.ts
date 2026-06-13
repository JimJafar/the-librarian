// Filesystem path resolution for the installer CLI.
//
// Everything the CLI persists lives under `~/.librarian/`. The home
// directory is *injectable* — every path helper takes an optional
// `home` argument that defaults to `os.homedir()`. Tests pass a temp
// dir so they never touch the real `~/.librarian`. Production code
// passes nothing and gets the real home.

import os from "node:os";
import path from "node:path";

/** The user's home directory, unless overridden (tests). */
export function homeDir(home?: string): string {
  return home ?? os.homedir();
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
