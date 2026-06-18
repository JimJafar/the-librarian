// OpenCode harness.
//
// OpenCode has no native install command, so we edit its global config
// (`~/.config/opencode/opencode.json`) idempotently, preserving every key
// the user already had. We add three things:
//
//   - `mcp.librarian`: a remote MCP block (type/url/enabled/headers). The
//     Authorization header references the env var, not the token value —
//     `Bearer {env:LIBRARIAN_AGENT_TOKEN}` — so the secret never lands in
//     the file (spec §9).
//   - the primer entry `<serverUrl>/primer.md` in the `instructions` array.
//   - the per-turn auto-capture PLUGIN (spec 2026-06-16-harness-auto-capture,
//     Phase 2A): the OpenCode integration's `plugin/` tree is fetched from the
//     pinned release tarball into `~/.librarian/opencode-capture` (exactly like
//     the Codex/Hermes adapters), and the entry's absolute path is registered in
//     opencode.json's `plugin` array so OpenCode loads it at startup.
//
// We stamp a managed version marker (`mcp.librarian._librarianVersion`) so
// detect can report a version, plus the EXACT primer URL we added
// (`mcp.librarian._librarianPrimer`) so uninstall removes only our own entry
// from `instructions` and never a foreign `…/primer.md`. detect =
// `mcp.librarian` present. uninstall removes only the keys/entries we added,
// leaving the rest of the JSON intact.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAdapterSubtree } from "../archive.js";
import { opencodeCaptureDir, opencodeConfigPath } from "../paths.js";
import { cliVersion } from "../version.js";
import type { HarnessConfig, HarnessModule } from "./types.js";

const SERVER_ID = "librarian";
const TOKEN_ENV_VAR = "LIBRARIAN_AGENT_TOKEN";
// Stamp the CLI's own version into the managed block (DERIVED, not hardcoded)
// so `librarian status`/`update` can compare installed-vs-latest honestly. A
// static literal would freeze the label and — since semver ranks `1.0.0` above
// `1.0.0-rc.N` — make status report "no update" against a newer pre-release.
const MANAGED_VERSION = cliVersion();
const VERSION_KEY = "_librarianVersion";
// The exact primer instruction we added, stamped into the managed block so
// uninstall can target only it (and not a foreign `…/primer.md`).
const PRIMER_KEY = "_librarianPrimer";

// ── Auto-capture plugin wiring (spec 2026-06-16-harness-auto-capture, Phase 2A) ─
// The capture-adapter source (integrations/opencode/plugin/**) does NOT ship with
// the published installer (it ships only dist/), so — exactly like the
// Codex/Hermes adapters — we FETCH it from the pinned release tarball and copy it
// under ~/.librarian/opencode-capture; opencode.json's `plugin` array points at
// the entry there. SC1 (true e2e against a running OpenCode) is DEFERRED — there
// is no `opencode` CLI on the build machine to confirm a live turn.

// The pinned monorepo release we fetch the adapter from: the tag matching this
// CLI's own version. DERIVED (not hardcoded) so it can't drift — same rationale
// as the Codex/Hermes adapters' pinned refs.
export const OPENCODE_CAPTURE_PINNED_REF = `v${cliVersion()}`;

/** The capture plugin entry, relative to the fetched integration / install dir. */
const PLUGIN_ENTRY_REL = path.join("plugin", "librarian-capture.ts");

interface OpenCodeMcpRemote {
  type: "remote";
  url: string;
  enabled: boolean;
  headers: Record<string, string>;
  [VERSION_KEY]?: string;
  [PRIMER_KEY]?: string;
}

interface OpenCodeConfig {
  mcp?: Record<string, unknown>;
  instructions?: unknown;
  plugin?: unknown;
  [key: string]: unknown;
}

/** Absolute path of the installed capture-plugin entry (what `plugin[]` points at). */
function pluginEntryPath(): string {
  return path.join(opencodeCaptureDir(), PLUGIN_ENTRY_REL);
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
    // Stamp the exact primer entry we add so uninstall removes only ours.
    [PRIMER_KEY]: primerEntry(cfg.serverUrl),
  };
}

function getMcpEntry(config: OpenCodeConfig | null): OpenCodeMcpRemote | undefined {
  const mcp = config?.mcp;
  if (mcp && typeof mcp === "object" && SERVER_ID in mcp) {
    return mcp[SERVER_ID] as OpenCodeMcpRemote;
  }
  return undefined;
}

// ── capture-adapter sourcing (mirrors Codex's injectable CaptureFetcher) ──────

/**
 * Fetches the OpenCode capture integration for a pinned ref and returns the
 * absolute path to a directory whose contents ARE the integration (the equivalent
 * of `integrations/opencode/`, i.e. holding `plugin/**`). The caller copies from
 * there. Injectable so tests substitute a local fixture instead of the network.
 */
export type CaptureFetcher = (ref: string) => Promise<string>;

/** The default fetcher: codeload tarball → `tar` extract → integration dir. */
const defaultCaptureFetcher: CaptureFetcher = async (ref) => {
  const url = `https://codeload.github.com/JimJafar/the-librarian/tar.gz/refs/tags/${ref}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-opencode-fetch-"));
  const tarball = path.join(work, "src.tar.gz");
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenCode capture adapter (${ref}): HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tarball, buf);
  // codeload nests the integration at `the-librarian-<ref>/integrations/opencode/**`;
  // the returned dir holds its contents (`plugin/`), which is what the caller
  // copies into ~/.librarian/.
  try {
    return await extractAdapterSubtree(tarball, work, "integrations/opencode");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to extract OpenCode capture adapter: ${msg}`);
  }
};

let captureFetcher: CaptureFetcher = defaultCaptureFetcher;

/** Override the capture-adapter fetcher (tests inject a local-fixture fetcher). */
export function setOpencodeCaptureFetcher(next: CaptureFetcher): void {
  captureFetcher = next;
}

/** Restore the default (network) capture-adapter fetcher (tests). */
export function resetOpencodeCaptureFetcher(): void {
  captureFetcher = defaultCaptureFetcher;
}

/** Recursively copy a directory tree, overwriting any prior copy (idempotent). */
function copyDir(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/**
 * Fetch + copy the capture plugin under ~/.librarian/opencode-capture, then
 * register the entry's absolute path in opencode.json's `plugin` array
 * (idempotent — never a duplicate, preserving any foreign plugins). Mutates +
 * returns `config` so the caller writes it once alongside the mcp/primer edits.
 */
async function installCapturePlugin(config: OpenCodeConfig): Promise<OpenCodeConfig> {
  const integrationDir = await captureFetcher(OPENCODE_CAPTURE_PINNED_REF);
  copyDir(integrationDir, opencodeCaptureDir());

  const entry = pluginEntryPath();
  const existing = Array.isArray(config.plugin)
    ? (config.plugin as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (!existing.includes(entry)) existing.push(entry);
  config.plugin = existing;
  return config;
}

/**
 * Remove our capture wiring: strip ONLY our `plugin` entry (preserving foreigns,
 * dropping an emptied array) and delete the scripts dir. Mutates `config`; returns
 * whether anything changed so the caller can decide to write.
 */
function uninstallCapturePlugin(config: OpenCodeConfig): boolean {
  let changed = false;
  const ours = pluginEntryPath();
  if (Array.isArray(config.plugin)) {
    const before = config.plugin as unknown[];
    const kept = before.filter((x) => x !== ours);
    if (kept.length !== before.length) {
      changed = true;
      if (kept.length === 0) delete config.plugin;
      else config.plugin = kept;
    }
  }
  fs.rmSync(opencodeCaptureDir(), { recursive: true, force: true });
  return changed;
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

    // plugin — fetch + copy the per-turn capture plugin and register its entry in
    // the `plugin` array (idempotent). Mutates `config`; written once below.
    await installCapturePlugin(config);

    writeConfig(config);
  },

  async uninstall() {
    const config = readConfig();
    if (!config) {
      // No config to edit — but still remove the fetched capture scripts dir so an
      // uninstall always cleans ~/.librarian/opencode-capture (mirrors Codex).
      fs.rmSync(opencodeCaptureDir(), { recursive: true, force: true });
      return;
    }

    let changed = false;

    // Read the EXACT primer entry we stamped before removing our block, so we
    // can target only our own instruction and never a foreign `…/primer.md`.
    const ourPrimer = getMcpEntry(config)?.[PRIMER_KEY];

    // Remove our mcp.librarian key only.
    if (config.mcp && typeof config.mcp === "object" && SERVER_ID in config.mcp) {
      delete (config.mcp as Record<string, unknown>)[SERVER_ID];
      changed = true;
      // Drop an emptied mcp object so we don't leave `{"mcp":{}}` litter.
      if (Object.keys(config.mcp).length === 0) delete config.mcp;
    }

    // Remove only OUR exact primer entry from instructions, preserving the
    // rest (including any foreign `…/primer.md` we didn't add).
    if (typeof ourPrimer === "string" && Array.isArray(config.instructions)) {
      const before = config.instructions as unknown[];
      const kept = before.filter((x) => x !== ourPrimer);
      if (kept.length !== before.length) {
        changed = true;
        if (kept.length === 0) delete config.instructions;
        else config.instructions = kept;
      }
    }

    // Remove our capture-plugin entry + delete the fetched scripts dir (always —
    // the dir removal is independent of whether the config carried our entry).
    if (uninstallCapturePlugin(config)) changed = true;

    if (changed) writeConfig(config);
  },

  async update(cfg: HarnessConfig) {
    await this.install(cfg);
  },
};
