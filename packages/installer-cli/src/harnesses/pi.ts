// Pi harness.
//
// Drives the native `pi` CLI — we never hand-edit Pi config. The extension
// is the npm package `the-librarian-pi-extension`.
//
//   detect    `pi` on PATH AND `pi list` shows the-librarian-pi-extension
//   install   `pi install npm:the-librarian-pi-extension`
//   uninstall `pi uninstall the-librarian-pi-extension`
//   update    re-run install (idempotent; pulls the current version)
//
// The token plays no part here — Pi's MCP auth is configured by the
// extension/env — so nothing token-shaped is ever passed or logged.

import { run, which } from "../exec.js";
import type { HarnessConfig, HarnessModule } from "./types.js";

const CLI = "pi";
const EXTENSION = "the-librarian-pi-extension";
const INSTALL_SPEC = `npm:${EXTENSION}`;

function notFound(): Error {
  return new Error("Pi CLI not found on PATH (expected `pi`).");
}

/** True iff `pi list` output shows our extension. */
function extensionListed(listOutput: string): boolean {
  return listOutput.split("\n").some((line) => line.includes(EXTENSION));
}

/** Pull the extension's version from a `pi list` line, if formatted. */
function parseExtensionVersion(listOutput: string): string | undefined {
  for (const line of listOutput.split("\n")) {
    if (!line.includes(EXTENSION)) continue;
    const m = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(line);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

export const pi: HarnessModule = {
  id: "pi",
  displayName: "Pi",

  async detect() {
    if (!(await which(CLI))) return { installed: false };
    const { stdout, code } = await run(CLI, ["list"]);
    if (code !== 0 || !extensionListed(stdout)) return { installed: false };
    const version = parseExtensionVersion(stdout);
    return version === undefined ? { installed: true } : { installed: true, version };
  },

  async install(_cfg: HarnessConfig) {
    if (!(await which(CLI))) throw notFound();
    // Idempotent: if already listed, installing again is a no-op.
    const { stdout: listed } = await run(CLI, ["list"]);
    if (extensionListed(listed)) return;
    const result = await run(CLI, ["install", INSTALL_SPEC]);
    if (result.code !== 0) {
      throw new Error(`pi install failed: ${oneLine(result.stderr || result.stdout)}`);
    }
  },

  async uninstall() {
    if (!(await which(CLI))) return; // nothing to remove if the CLI is gone
    // `pi uninstall` of an absent extension is a no-op; surface only real errors.
    await run(CLI, ["uninstall", EXTENSION]);
  },

  async update(cfg: HarnessConfig) {
    await this.install(cfg);
  },
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
