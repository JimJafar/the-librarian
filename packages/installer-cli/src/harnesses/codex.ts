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
import os from "node:os";
import path from "node:path";
import { run, which } from "../exec.js";
import { codexCaptureDir, codexConfigPath, codexHooksPath } from "../paths.js";
import { cliVersion } from "../version.js";
import type { HarnessConfig, HarnessModule } from "./types.js";

const CLI = "codex";
const SERVER_ID = "librarian";
const TOKEN_ENV_VAR = "LIBRARIAN_AGENT_TOKEN";
const TABLE_HEADER = "[mcp_servers.librarian]";
// The config-shape version we stamp, so detect can report something even
// though TOML carries no native version for an MCP entry.
const CONFIG_VERSION = "1";
const VERSION_MARKER = "# librarian-config-version =";

// ── Auto-capture hooks wiring (spec 2026-06-16-harness-auto-capture, Phase 2A) ─
//
// Codex fires the same command-hook events as Claude (UserPromptSubmit / Stop /
// SessionEnd). Codex discovers lifecycle hooks ONLY at ~/.codex/hooks.json (no
// plugin host auto-wires them), so — mirroring mem0's install_codex_hooks.py — we
// MERGE our entries into that file (creating it if absent) and surface the
// `codex_hooks = true` feature-flag requirement. The merge is idempotent: entries
// we own are identified by an owner marker in the command string and stripped
// before fresh ones are added, so re-install/upgrade leaves no duplicates.
//
// The capture-adapter scripts (integrations/codex/scripts/**) do NOT ship with
// the published installer (it ships only dist/), so — exactly like the Hermes
// adapter — we FETCH them from the pinned release tarball and copy them under
// ~/.librarian/codex-capture; the merged hook commands point their
// ${LIBRARIAN_CODEX_ROOT} placeholder at that dir.
//
// ASSUMPTION (the one genuine unknown): the assumed hook events + payload shape
// are derived from mem0's proven Codex wiring + the Claude payload (documented in
// integrations/codex/scripts/lib/transcript.mjs). SC1 (true e2e against a running
// Codex) is DEFERRED — there is no codex CLI on the build machine to confirm.

// The placeholder in hooks/codex-hooks.json, rewritten to the absolute scripts
// install dir at merge time. Matches the env var the entry shell reads.
const ROOT_PLACEHOLDER = "${LIBRARIAN_CODEX_ROOT}";
// Substring that identifies entries THIS installer owns (stable across install
// paths), so the merge can strip + re-add idempotently. Mirrors mem0's
// OWNER_MARKER = "mem0-plugin".
const HOOKS_OWNER_MARKER = "the-librarian-codex";
// The pinned monorepo release we fetch the adapter from: the tag matching this
// CLI's own version. DERIVED (not hardcoded) so it can't drift — same rationale
// as the Hermes adapter's PINNED_REF.
export const CODEX_CAPTURE_PINNED_REF = `v${cliVersion()}`;

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

// ── capture-adapter sourcing (mirrors Hermes's injectable AdapterFetcher) ─────

/**
 * Fetches the Codex capture integration for a pinned ref and returns the absolute
 * path to a directory whose contents ARE the integration (the equivalent of
 * `integrations/codex/`, i.e. holding `scripts/**` and `hooks/codex-hooks.json`).
 * The caller copies from there. Injectable so tests substitute a local fixture
 * instead of the network.
 */
export type CaptureFetcher = (ref: string) => Promise<string>;

/** The default fetcher: codeload tarball → `tar` extract → integration dir. */
const defaultCaptureFetcher: CaptureFetcher = async (ref) => {
  const url = `https://codeload.github.com/JimJafar/the-librarian/tar.gz/refs/tags/${ref}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-codex-fetch-"));
  const tarball = path.join(work, "src.tar.gz");
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) {
    throw new Error(`Failed to fetch Codex capture adapter (${ref}): HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tarball, buf);
  // codeload nests the integration at `the-librarian-<ref>/integrations/codex/**`
  // — three leading path components. Strip them so `scripts/` + `hooks/` land at
  // the extraction root, which is what the caller copies into ~/.librarian/.
  const out = path.join(work, "adapter");
  fs.mkdirSync(out, { recursive: true });
  const extract = await run("tar", [
    "-xzf",
    tarball,
    "-C",
    out,
    "--strip-components=3",
    "--wildcards",
    "*/integrations/codex/*",
  ]);
  if (extract.code !== 0) {
    throw new Error(`Failed to extract Codex capture adapter: ${(extract.stderr || "").trim()}`);
  }
  return out;
};

let captureFetcher: CaptureFetcher = defaultCaptureFetcher;

/** Override the capture-adapter fetcher (tests inject a local-fixture fetcher). */
export function setCodexCaptureFetcher(next: CaptureFetcher): void {
  captureFetcher = next;
}

/** Restore the default (network) capture-adapter fetcher (tests). */
export function resetCodexCaptureFetcher(): void {
  captureFetcher = defaultCaptureFetcher;
}

/** Recursively copy a directory tree, overwriting any prior copy (idempotent). */
function copyDir(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

// ── ~/.codex/hooks.json merge (idempotent via the owner marker) ───────────────

interface CodexHookCommand {
  command?: unknown;
  [k: string]: unknown;
}
interface CodexHookEntry {
  hooks?: CodexHookCommand[];
  [k: string]: unknown;
}
interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>;
  [k: string]: unknown;
}

/** Read ~/.codex/hooks.json, or an empty shape if absent/unparseable. */
function readHooksFile(): CodexHooksFile {
  try {
    const raw = fs.readFileSync(codexHooksPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CodexHooksFile;
    }
  } catch {
    // absent / unreadable / malformed — start from an empty shape
  }
  return { hooks: {} };
}

function writeHooksFile(config: CodexHooksFile): void {
  const file = codexHooksPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Does this entry belong to us (owner marker in any command string)? */
function isOwnedEntry(entry: CodexHookEntry): boolean {
  return (entry.hooks ?? []).some(
    (h) => typeof h.command === "string" && h.command.includes(HOOKS_OWNER_MARKER),
  );
}

/** Remove every entry we own from a hooks file (so a re-merge can't duplicate). */
function stripOwnedEntries(config: CodexHooksFile): CodexHooksFile {
  const hooks = config.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] ?? []).filter((e) => !isOwnedEntry(e));
    if (hooks[event].length === 0) delete hooks[event];
  }
  config.hooks = hooks;
  return config;
}

/**
 * Load our hooks template, rewrite the ${LIBRARIAN_CODEX_ROOT} placeholder to the
 * absolute scripts dir, and return the parsed shape. The template lives in the
 * fetched integration dir alongside the scripts it points at.
 */
function loadTemplate(integrationDir: string, scriptsRoot: string): CodexHooksFile {
  const raw = fs.readFileSync(path.join(integrationDir, "hooks", "codex-hooks.json"), "utf8");
  // JSON-string-escape the path so a backslash (Windows) can't break the JSON.
  const safe = JSON.stringify(scriptsRoot).slice(1, -1);
  const rewritten = raw.split(ROOT_PLACEHOLDER).join(safe);
  return JSON.parse(rewritten) as CodexHooksFile;
}

/** Merge template entries onto a (stripped) config, appending per event. */
function mergeTemplate(config: CodexHooksFile, template: CodexHooksFile): CodexHooksFile {
  const hooks = (config.hooks ??= {});
  for (const [event, entries] of Object.entries(template.hooks ?? {})) {
    // Drop the template's own "//" doc keys etc. — only carry real entries.
    (hooks[event] ??= []).push(...entries);
  }
  return config;
}

/** True iff `codex_hooks = true` is set under [features] in config.toml. */
function captureFeatureFlagEnabled(config: string): boolean {
  for (const line of config.split("\n")) {
    // Strip an inline comment, then collapse whitespace, so `codex_hooks = true`
    // (any spacing) matches but a `# codex_hooks = true` comment does not.
    const stripped = (line.split("#", 1)[0] ?? "").trim().replace(/\s+/g, "");
    if (stripped === "codex_hooks=true") return true;
  }
  return false;
}

/**
 * Wire (or re-wire) the per-turn capture hooks: fetch + copy the adapter scripts,
 * then idempotently merge our entries into ~/.codex/hooks.json. Returns whether
 * the user still needs to enable the `codex_hooks` feature flag (so the caller can
 * surface the hint, mirroring mem0's print_feature_flag_hint).
 */
async function installCaptureHooks(): Promise<{ featureFlagNeeded: boolean }> {
  const integrationDir = await captureFetcher(CODEX_CAPTURE_PINNED_REF);
  const scriptsRoot = codexCaptureDir();
  copyDir(integrationDir, scriptsRoot);

  const template = loadTemplate(integrationDir, scriptsRoot);
  const config = stripOwnedEntries(readHooksFile());
  writeHooksFile(mergeTemplate(config, template));

  return { featureFlagNeeded: !captureFeatureFlagEnabled(readConfig()) };
}

/** Remove our capture wiring: strip owned hook entries + delete the scripts dir. */
function uninstallCaptureHooks(): void {
  if (fs.existsSync(codexHooksPath())) {
    writeHooksFile(stripOwnedEntries(readHooksFile()));
  }
  fs.rmSync(codexCaptureDir(), { recursive: true, force: true });
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
    // Two independently-idempotent halves: (1) the MCP server table (the tools +
    // primer surface) and (2) the per-turn auto-capture hooks. Both run on every
    // install so a second install repairs either half if only one is present.
    await installMcpTable(cfg);
    const { featureFlagNeeded } = await installCaptureHooks();
    // Codex won't FIRE lifecycle hooks until `codex_hooks = true` is set under
    // [features] in config.toml (mirrors mem0's print_feature_flag_hint). We can't
    // edit a TOML table the user owns safely from here, so we SURFACE the one-time
    // requirement on stderr. Fail-soft: this is a hint, never a hard failure.
    if (featureFlagNeeded) {
      process.stderr.write(
        `\nCodex auto-capture is wired, but Codex won't run the hooks until you enable the\n` +
          `feature flag. Add this to ${codexConfigPath()}:\n\n` +
          `  [features]\n  codex_hooks = true\n\nThen restart Codex.\n`,
      );
    }
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
    // Remove the auto-capture wiring (owned hook entries + the scripts dir).
    uninstallCaptureHooks();
  },

  async update(cfg: HarnessConfig) {
    // Re-applying is idempotent; install short-circuits when present.
    await this.install(cfg);
  },
};

/**
 * Install/repair just the MCP server table — the original Codex wiring. Prefers
 * the native `codex` CLI; falls back to editing config.toml directly when the CLI
 * isn't on PATH. Idempotent (a present table is a no-op).
 */
async function installMcpTable(cfg: HarnessConfig): Promise<void> {
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
}

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
