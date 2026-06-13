// Hermes harness.
//
// Hermes has no native install command for a memory provider, so we:
//   - copy the adapter into `~/.hermes/plugins/librarian`, and
//   - set `memory.provider = librarian` in `~/.hermes/config.json`.
//
//   detect    plugin dir present AND provider set to "librarian"
//             version comes from the adapter's `plugin.yaml`
//   uninstall remove the plugin dir + unset the provider key
//   update    re-fetch + re-copy the adapter (idempotent)
//
// ARTIFACT SOURCING. On a user's machine the adapter does NOT live in the
// repo — the CLI must fetch it from a pinned release. We download a tarball
// of the pinned ref from GitHub's codeload endpoint
//   https://codeload.github.com/JimJafar/the-librarian/tar.gz/refs/tags/<ref>
// and extract `integrations/hermes/librarian/**` out of it with `tar`. The
// FETCH is injectable (`setAdapterFetcher`): tests inject a fetcher that
// returns a local fixture dir, so nothing touches the network. The pinned
// ref defaults to the repo's current release tag (PINNED_REF).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../exec.js";
import { hermesConfigPath, hermesHomeDir, hermesPluginDir } from "../paths.js";
import type { HarnessConfig, HarnessModule } from "./types.js";

const PROVIDER_ID = "librarian";
// The pinned monorepo release we fetch the adapter from. Default to the
// repo's current release tag; the phase gate owns version bumps.
export const PINNED_REF = "v1.0.0-rc.5";

/**
 * Fetches the Hermes adapter for a pinned ref and returns the absolute
 * path to a directory whose contents ARE the adapter (the equivalent of
 * `integrations/hermes/librarian/`). The caller copies from there.
 *
 * Injectable so tests substitute a local fixture instead of the network.
 */
export type AdapterFetcher = (ref: string) => Promise<string>;

/** The default fetcher: codeload tarball → `tar` extract → adapter dir. */
const defaultFetcher: AdapterFetcher = async (ref) => {
  const url = `https://codeload.github.com/JimJafar/the-librarian/tar.gz/refs/tags/${ref}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-hermes-fetch-"));
  const tarball = path.join(work, "src.tar.gz");
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) {
    throw new Error(`Failed to fetch Hermes adapter (${ref}): HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tarball, buf);
  // codeload nests the adapter at
  //   the-librarian-<ref>/integrations/hermes/librarian/**
  // — four leading path components. Strip all four so the adapter's own
  // files (plugin.yaml, …) land at the extraction root, which is what the
  // caller copies into `~/.hermes/plugins/librarian/`.
  const out = path.join(work, "adapter");
  fs.mkdirSync(out, { recursive: true });
  const extract = await run("tar", [
    "-xzf",
    tarball,
    "-C",
    out,
    "--strip-components=4",
    "--wildcards",
    "*/integrations/hermes/librarian/*",
  ]);
  if (extract.code !== 0) {
    throw new Error(`Failed to extract Hermes adapter: ${(extract.stderr || "").trim()}`);
  }
  return out;
};

let fetcher: AdapterFetcher = defaultFetcher;

/** Override the adapter fetcher (tests inject a local-fixture fetcher). */
export function setAdapterFetcher(next: AdapterFetcher): void {
  fetcher = next;
}

/** Restore the default (network) adapter fetcher (tests). */
export function resetAdapterFetcher(): void {
  fetcher = defaultFetcher;
}

interface HermesConfig {
  memory?: { provider?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

function readHermesConfig(): HermesConfig | null {
  try {
    const raw = fs.readFileSync(hermesConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HermesConfig;
    }
    return null;
  } catch {
    return null;
  }
}

function writeHermesConfig(config: HermesConfig): void {
  fs.mkdirSync(hermesHomeDir(), { recursive: true });
  fs.writeFileSync(hermesConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** True iff `memory.provider` is set to our provider id. */
function providerSet(): boolean {
  const config = readHermesConfig();
  return config?.memory?.provider === PROVIDER_ID;
}

/** Parse `version:` from the installed adapter's plugin.yaml, if present. */
function readAdapterVersion(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(hermesPluginDir(), "plugin.yaml"), "utf8");
    for (const line of raw.split("\n")) {
      const m = /^\s*version\s*:\s*["']?([^"'#\s]+)/.exec(line);
      if (m?.[1]) return m[1];
    }
  } catch {
    // dir/file gone — no version
  }
  return undefined;
}

/** Recursively copy a directory tree (Node 22 `fs.cpSync`). */
function copyDir(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

export const hermes: HarnessModule = {
  id: "hermes",
  displayName: "Hermes",

  async detect() {
    const dirPresent = fs.existsSync(hermesPluginDir());
    if (!dirPresent || !providerSet()) return { installed: false };
    const version = readAdapterVersion();
    return version === undefined ? { installed: true } : { installed: true, version };
  },

  async install(_cfg: HarnessConfig) {
    // Fetch the adapter for the pinned ref (network by default; a local
    // fixture in tests) and copy it into place — overwriting any prior copy
    // so re-running is idempotent.
    const adapterDir = await fetcher(PINNED_REF);
    copyDir(adapterDir, hermesPluginDir());

    // Set memory.provider = librarian, preserving any other config keys.
    const config = readHermesConfig() ?? {};
    const memory = (config.memory && typeof config.memory === "object" ? config.memory : {}) as {
      provider?: unknown;
      [k: string]: unknown;
    };
    memory.provider = PROVIDER_ID;
    config.memory = memory;
    writeHermesConfig(config);
  },

  async uninstall() {
    // Remove the plugin dir (no-op if already gone).
    fs.rmSync(hermesPluginDir(), { recursive: true, force: true });

    // Unset memory.provider only if it's ours, preserving other keys.
    const config = readHermesConfig();
    if (config?.memory && typeof config.memory === "object") {
      if (config.memory.provider === PROVIDER_ID) {
        delete config.memory.provider;
        if (Object.keys(config.memory).length === 0) delete config.memory;
        writeHermesConfig(config);
      }
    }
  },

  async update(cfg: HarnessConfig) {
    await this.install(cfg);
  },
};
