// Codex harness.
//
// Prefers the native `codex` CLI; falls back to editing the config file
// directly only when `codex` isn't on PATH but the config is still
// writable (so a partial Codex setup can still be wired up).
//
//   detect    `~/.codex/config.toml` has a `[mcp_servers.librarian]` table
//   install   `codex mcp add librarian --url <U>
//                 --bearer-token-env-var LIBRARIAN_AGENT_TOKEN`
//             (fallback: write the table into config.toml)
//   uninstall `codex mcp remove librarian` (fallback: strip the table)
//   update    re-run install (idempotent)
//
// Token handling (spec §9): the token's *value* never enters config or the
// command line. Codex stores only the env-var NAME `LIBRARIAN_AGENT_TOKEN`;
// it resolves the value at request time. We pass `cfg.mcpUrl` (not the
// token) on the CLI, so nothing secret is ever logged.

import fs from "node:fs";
import path from "node:path";
import { run, which } from "../exec.js";
import { codexConfigPath } from "../paths.js";
import type { HarnessConfig, HarnessModule } from "./types.js";

const CLI = "codex";
const SERVER_ID = "librarian";
const TOKEN_ENV_VAR = "LIBRARIAN_AGENT_TOKEN";
const TABLE_HEADER = "[mcp_servers.librarian]";
// The config-shape version we stamp, so detect can report something even
// though TOML carries no native version for an MCP entry.
const CONFIG_VERSION = "1";
const VERSION_MARKER = "# librarian-config-version =";

/** Read config.toml, or "" if it doesn't exist yet. */
function readConfig(): string {
  try {
    return fs.readFileSync(codexConfigPath(), "utf8");
  } catch {
    return "";
  }
}

/** True iff the config text already declares our MCP server table. */
function hasTable(config: string): boolean {
  return config.split("\n").some((line) => line.trim() === TABLE_HEADER);
}

/** Parse the stamped config-shape version from a managed comment, if any. */
function parseConfigVersion(config: string): string | undefined {
  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(VERSION_MARKER)) {
      const v = trimmed
        .slice(VERSION_MARKER.length)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return undefined;
}

/** Append our managed table to existing config text (idempotent caller). */
function withTable(config: string, cfg: HarnessConfig): string {
  const block = [
    `${VERSION_MARKER} "${CONFIG_VERSION}"`,
    TABLE_HEADER,
    `url = ${tomlString(cfg.mcpUrl)}`,
    `bearer_token_env_var = ${tomlString(TOKEN_ENV_VAR)}`,
  ].join("\n");
  const base = config.length === 0 || config.endsWith("\n") ? config : `${config}\n`;
  const sep = base.length === 0 ? "" : "\n";
  return `${base}${sep}${block}\n`;
}

/** Strip our managed table (and its version marker) from config text. */
function withoutTable(config: string): string {
  const lines = config.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === VERSION_MARKER || trimmed.startsWith(VERSION_MARKER)) {
      // Drop a marker line immediately preceding our table.
      continue;
    }
    if (trimmed === TABLE_HEADER) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // A new table header (or end of our keys) ends the skip region.
      if (/^\[.+\]$/.test(trimmed)) {
        skipping = false;
        out.push(line);
        continue;
      }
      if (trimmed === "" || /^[A-Za-z0-9_]+\s*=/.test(trimmed)) {
        continue; // a key/blank inside our table — drop it
      }
      skipping = false;
    }
    out.push(line);
  }
  // Tidy trailing blank lines.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

function writeConfig(content: string): void {
  const file = codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

export const codex: HarnessModule = {
  id: "codex",
  displayName: "Codex",

  async detect() {
    const config = readConfig();
    if (!hasTable(config)) return { installed: false };
    const version = parseConfigVersion(config) ?? CONFIG_VERSION;
    return { installed: true, version };
  },

  async install(cfg: HarnessConfig) {
    if (await which(CLI)) {
      // Idempotent: if our table is already present, do nothing.
      if (hasTable(readConfig())) return;
      const result = await run(CLI, [
        "mcp",
        "add",
        SERVER_ID,
        "--url",
        cfg.mcpUrl,
        "--bearer-token-env-var",
        TOKEN_ENV_VAR,
      ]);
      if (result.code !== 0) {
        throw new Error(`codex mcp add failed: ${oneLine(result.stderr || result.stdout)}`);
      }
      // Stamp our config-shape version alongside the CLI-written table so
      // detect can report it (the CLI doesn't write the marker comment).
      stampVersionIfMissing();
      return;
    }
    // Fallback: no `codex` on PATH. We can still write the config file.
    const config = readConfig();
    if (hasTable(config)) return; // idempotent
    writeConfig(withTable(config, cfg));
  },

  async uninstall() {
    if (await which(CLI)) {
      // `codex mcp remove` is a no-op when the server is absent.
      await run(CLI, ["mcp", "remove", SERVER_ID]);
    }
    // Always clean the config text too (covers the CLI-absent path and the
    // version marker the CLI doesn't manage).
    const config = readConfig();
    if (hasTable(config) || parseConfigVersion(config) !== undefined) {
      writeConfig(withoutTable(config));
    }
  },

  async update(cfg: HarnessConfig) {
    // Re-applying is idempotent; install short-circuits when present.
    await this.install(cfg);
  },
};

/** If the table exists but our version marker doesn't, add the marker. */
function stampVersionIfMissing(): void {
  const config = readConfig();
  if (!hasTable(config) || parseConfigVersion(config) !== undefined) return;
  const lines = config.split("\n");
  const idx = lines.findIndex((line) => line.trim() === TABLE_HEADER);
  if (idx === -1) return;
  lines.splice(idx, 0, `${VERSION_MARKER} "${CONFIG_VERSION}"`);
  writeConfig(lines.join("\n"));
}

/** Double-quote a TOML string value with minimal escaping. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
