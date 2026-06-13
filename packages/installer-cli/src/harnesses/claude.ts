// Claude Code harness.
//
// Drives the `claude` CLI's native plugin/marketplace commands — we never
// hand-edit Claude config. The marketplace is `JimJafar/the-librarian`;
// the plugin is `the-librarian@the-librarian` (name@marketplace).
//
//   detect    `claude` on PATH AND `claude plugin list` shows our plugin
//   install   `claude plugin marketplace add JimJafar/the-librarian`
//             then `claude plugin install the-librarian@the-librarian`
//   uninstall `claude plugin remove the-librarian@the-librarian`
//             then `claude plugin marketplace remove the-librarian`
//   update    re-run install (idempotent; pulls the current version)
//
// The token plays no part here — Claude's MCP auth is configured by the
// plugin itself — so nothing token-shaped is ever passed or logged.

import { run, which } from "../exec.js";
import type { HarnessConfig, HarnessModule } from "./types.js";

const CLI = "claude";
const MARKETPLACE = "JimJafar/the-librarian";
const MARKETPLACE_ID = "the-librarian";
const PLUGIN = "the-librarian@the-librarian";
const PLUGIN_NAME = "the-librarian";

/** Friendly error when the harness CLI isn't installed. */
function notFound(): Error {
  return new Error("Claude Code CLI not found on PATH (expected `claude`).");
}

/**
 * Pull our plugin's version out of `claude plugin list` output, which
 * formats loosely across versions. We look for a line mentioning the
 * plugin and a trailing semver-ish token; absence is `undefined`.
 */
function parsePluginVersion(listOutput: string): string | undefined {
  for (const line of listOutput.split("\n")) {
    if (!line.includes(PLUGIN_NAME)) continue;
    const m = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(line);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** True iff `claude plugin list` output shows our plugin as present. */
function pluginListed(listOutput: string): boolean {
  return listOutput.split("\n").some((line) => line.includes(PLUGIN_NAME));
}

export const claude: HarnessModule = {
  id: "claude",
  displayName: "Claude Code",

  async detect() {
    if (!(await which(CLI))) return { installed: false };
    const { stdout, code } = await run(CLI, ["plugin", "list"]);
    if (code !== 0 || !pluginListed(stdout)) return { installed: false };
    const version = parsePluginVersion(stdout);
    return version === undefined ? { installed: true } : { installed: true, version };
  },

  async install(_cfg: HarnessConfig) {
    if (!(await which(CLI))) throw notFound();
    // marketplace add is idempotent in the CLI; installing again is a no-op
    // re-resolve, so a second `install` neither errors nor duplicates.
    const add = await run(CLI, ["plugin", "marketplace", "add", MARKETPLACE]);
    if (add.code !== 0) {
      throw new Error(`claude plugin marketplace add failed: ${oneLine(add.stderr || add.stdout)}`);
    }
    const install = await run(CLI, ["plugin", "install", PLUGIN]);
    if (install.code !== 0) {
      throw new Error(`claude plugin install failed: ${oneLine(install.stderr || install.stdout)}`);
    }
  },

  async uninstall() {
    if (!(await which(CLI))) return; // nothing to remove if the CLI is gone
    // Removing an absent plugin / marketplace is a no-op; we don't fail the
    // uninstall on a "not installed" exit, only surface genuine errors.
    await run(CLI, ["plugin", "remove", PLUGIN]);
    await run(CLI, ["plugin", "marketplace", "remove", MARKETPLACE_ID]);
  },

  async update(cfg: HarnessConfig) {
    // Re-running install pulls the marketplace's current version.
    await this.install(cfg);
  },
};

/** Collapse multi-line CLI error text to a single tidy line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
