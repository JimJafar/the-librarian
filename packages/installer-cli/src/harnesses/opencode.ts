// OpenCode harness.
//
// OpenCode has no native install command, so we edit its global config
// (`~/.config/opencode/opencode.json`) idempotently, preserving every key
// the user already had. We add exactly two things:
//
//   - `mcp.librarian`: a remote MCP block (type/url/enabled/headers). The
//     Authorization header references the env var, not the token value —
//     `Bearer {env:LIBRARIAN_AGENT_TOKEN}` — so the secret never lands in
//     the file (spec §9).
//   - the primer entry `<serverUrl>/primer.md` in the `instructions` array.
//
// We stamp a managed version marker (`mcp.librarian._librarianVersion`) so
// detect can report a version. detect = `mcp.librarian` present. uninstall
// removes only the keys/entries we added, leaving the rest of the JSON
// intact.

import fs from "node:fs";
import path from "node:path";
import { opencodeConfigPath } from "../paths.js";
import type { HarnessConfig, HarnessModule } from "./types.js";

const SERVER_ID = "librarian";
const TOKEN_ENV_VAR = "LIBRARIAN_AGENT_TOKEN";
const MANAGED_VERSION = "1.0.0";
const VERSION_KEY = "_librarianVersion";

interface OpenCodeMcpRemote {
  type: "remote";
  url: string;
  enabled: boolean;
  headers: Record<string, string>;
  [VERSION_KEY]?: string;
}

interface OpenCodeConfig {
  mcp?: Record<string, unknown>;
  instructions?: unknown;
  [key: string]: unknown;
}

/** The primer instruction entry derived from the server URL. */
function primerEntry(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/primer.md`;
}

/** Read + parse opencode.json, or null if absent / unreadable / invalid. */
function readConfig(): OpenCodeConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(opencodeConfigPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OpenCodeConfig;
    }
    return null;
  } catch {
    return null;
  }
}

function writeConfig(config: OpenCodeConfig): void {
  const file = opencodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** The managed remote block we install. */
function librarianBlock(cfg: HarnessConfig): OpenCodeMcpRemote {
  return {
    type: "remote",
    url: cfg.mcpUrl,
    enabled: true,
    headers: { Authorization: `Bearer {env:${TOKEN_ENV_VAR}}` },
    [VERSION_KEY]: MANAGED_VERSION,
  };
}

function getMcpEntry(config: OpenCodeConfig | null): OpenCodeMcpRemote | undefined {
  const mcp = config?.mcp;
  if (mcp && typeof mcp === "object" && SERVER_ID in mcp) {
    return mcp[SERVER_ID] as OpenCodeMcpRemote;
  }
  return undefined;
}

export const opencode: HarnessModule = {
  id: "opencode",
  displayName: "OpenCode",

  async detect() {
    const entry = getMcpEntry(readConfig());
    if (!entry) return { installed: false };
    const version = typeof entry[VERSION_KEY] === "string" ? entry[VERSION_KEY] : undefined;
    return version === undefined ? { installed: true } : { installed: true, version };
  },

  async install(cfg: HarnessConfig) {
    const config: OpenCodeConfig = readConfig() ?? {};

    // mcp.librarian — overwrite our managed block (idempotent), preserve
    // every other mcp server.
    const mcp = (config.mcp && typeof config.mcp === "object" ? config.mcp : {}) as Record<
      string,
      unknown
    >;
    mcp[SERVER_ID] = librarianBlock(cfg);
    config.mcp = mcp;

    // instructions — ensure the primer entry is present exactly once,
    // preserving any existing entries. Tolerate a missing/non-array value.
    const entry = primerEntry(cfg.serverUrl);
    const existing = Array.isArray(config.instructions)
      ? (config.instructions as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (!existing.includes(entry)) existing.push(entry);
    config.instructions = existing;

    writeConfig(config);
  },

  async uninstall() {
    const config = readConfig();
    if (!config) return; // nothing to do — no-op when absent

    let changed = false;

    // Remove our mcp.librarian key only.
    if (config.mcp && typeof config.mcp === "object" && SERVER_ID in config.mcp) {
      delete (config.mcp as Record<string, unknown>)[SERVER_ID];
      changed = true;
      // Drop an emptied mcp object so we don't leave `{"mcp":{}}` litter.
      if (Object.keys(config.mcp).length === 0) delete config.mcp;
    }

    // Remove only OUR primer entries from instructions, preserving the rest.
    if (Array.isArray(config.instructions)) {
      const before = config.instructions as unknown[];
      const kept = before.filter((x) => !(typeof x === "string" && /\/primer\.md$/.test(x)));
      if (kept.length !== before.length) {
        changed = true;
        if (kept.length === 0) delete config.instructions;
        else config.instructions = kept;
      }
    }

    if (changed) writeConfig(config);
  },

  async update(cfg: HarnessConfig) {
    await this.install(cfg);
  },
};
