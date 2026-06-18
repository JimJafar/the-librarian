import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/exec.js";
import {
  hermes,
  PINNED_REF,
  resetAdapterFetcher,
  setAdapterFetcher,
  type AdapterFetcher,
} from "../src/harnesses/hermes.js";
import {
  hermesConfigPath,
  hermesPluginDir,
  resetHomeOverride,
  setHomeOverride,
} from "../src/paths.js";
import { cliVersion } from "../src/version.js";
import { withTempHome } from "./helpers.js";

const CFG = {
  mcpUrl: "https://x.example/mcp",
  token: "secret-token-xyz",
  serverUrl: "https://x.example",
};

const realFetch = globalThis.fetch;

afterEach(() => {
  resetHomeOverride();
  resetAdapterFetcher();
  globalThis.fetch = realFetch;
});

/**
 * Build a real codeload-shaped `.tar.gz` whose single top-level dir is
 * `the-librarian-<ref>/` and which carries the adapter subtree at
 * `the-librarian-<ref>/integrations/hermes/librarian/**`. Returns the bytes.
 * This is exactly the shape GitHub's `codeload .../tar.gz/refs/tags/<ref>`
 * endpoint serves, so it exercises the real `tar --strip-components` path.
 */
async function buildCodeloadTarball(ref: string, version = "1.0.0"): Promise<Buffer> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-codeload-fixture-"));
  const top = `the-librarian-${ref.replace(/^v/, "")}`;
  const adapter = path.join(work, top, "integrations", "hermes", "librarian");
  fs.mkdirSync(adapter, { recursive: true });
  fs.writeFileSync(
    path.join(adapter, "plugin.yaml"),
    `name: librarian\nversion: ${version}\ndescription: fixture\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(adapter, "__init__.py"), "# fixture\n", "utf8");
  // The Phase 2B auto-capture modules are plain sibling .py files in the adapter
  // dir — they must ride along in the extraction (the provider activates capture
  // automatically, so a dropped module would silently disable auto-capture).
  fs.writeFileSync(path.join(adapter, "provider.py"), "# fixture provider\n", "utf8");
  fs.writeFileSync(path.join(adapter, "capture.py"), "# fixture capture\n", "utf8");
  fs.writeFileSync(path.join(adapter, "capture_state.py"), "# fixture capture state\n", "utf8");
  // Sibling files OUTSIDE the adapter subtree — they must NOT be extracted.
  fs.writeFileSync(path.join(work, top, "README.md"), "# repo\n", "utf8");
  const tarball = path.join(work, "src.tar.gz");
  const res = await run("tar", ["-czf", tarball, "-C", work, top]);
  if (res.code !== 0) throw new Error(`fixture tar failed: ${res.stderr}`);
  const bytes = fs.readFileSync(tarball);
  fs.rmSync(work, { recursive: true, force: true });
  return bytes;
}

/**
 * Build a local fixture adapter dir (stands in for the fetched release
 * artifact) and return a fetcher that yields it — nothing touches the
 * network. The fixture carries a `plugin.yaml` with a known version + a
 * sentinel file so we can assert the copy.
 */
function fixtureFetcher(home: string, version = "1.0.0"): AdapterFetcher {
  const src = path.join(home, "fixture-adapter");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "plugin.yaml"),
    `name: librarian\nversion: ${version}\ndescription: fixture\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(src, "__init__.py"), "# fixture\n", "utf8");
  return async () => src;
}

describe("hermes harness", () => {
  it("detect: not installed when neither dir nor provider is set", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await expect(hermes.detect()).resolves.toEqual({ installed: false });
    });
  });

  it("detect: not installed when the dir exists but the provider isn't set", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      fs.mkdirSync(hermesPluginDir(home), { recursive: true });
      await expect(hermes.detect()).resolves.toEqual({ installed: false });
    });
  });

  it("install: copies the adapter, stamps the config, detect reports version", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setAdapterFetcher(fixtureFetcher(home, "1.0.0"));
      await hermes.install(CFG);

      // Adapter copied into ~/.hermes/plugins/librarian.
      expect(fs.existsSync(path.join(hermesPluginDir(home), "plugin.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(hermesPluginDir(home), "__init__.py"))).toBe(true);

      // memory.provider stamped.
      const cfg = JSON.parse(fs.readFileSync(hermesConfigPath(home), "utf8")) as {
        memory?: { provider?: string };
      };
      expect(cfg.memory?.provider).toBe("librarian");

      // install stamps the copied plugin.yaml with the CLI version, so detect
      // reports cliVersion() (the fetched tag's "1.0.0" is just a placeholder).
      expect(fs.readFileSync(path.join(hermesPluginDir(home), "plugin.yaml"), "utf8")).toContain(
        `version: ${cliVersion()}`,
      );
      await expect(hermes.detect()).resolves.toEqual({
        installed: true,
        version: cliVersion(),
      });

      // Token never lands in the config file.
      expect(fs.readFileSync(hermesConfigPath(home), "utf8")).not.toContain(CFG.token);
    });
  });

  it("install: the fetch is injectable (no network) and uses the pinned ref", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      let calledRef: string | undefined;
      const src = path.join(home, "adapter");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "plugin.yaml"), "name: librarian\nversion: 9.9.9\n", "utf8");
      setAdapterFetcher(async (ref) => {
        calledRef = ref;
        return src;
      });
      await hermes.install(CFG);
      expect(calledRef).toMatch(/^v\d+\.\d+\.\d+/);
      // install stamps the version over the fixture's "9.9.9" placeholder, so
      // detect reports cliVersion() — the version that installed it.
      await expect(hermes.detect()).resolves.toEqual({ installed: true, version: cliVersion() });
    });
  });

  it("install: idempotent — preserves unrelated hermes config keys", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      fs.mkdirSync(path.dirname(hermesConfigPath(home)), { recursive: true });
      fs.writeFileSync(
        hermesConfigPath(home),
        JSON.stringify({ memory: { other: "keep" }, model: "x" }, null, 2),
        "utf8",
      );
      setAdapterFetcher(fixtureFetcher(home));
      await hermes.install(CFG);
      await hermes.install(CFG);
      const cfg = JSON.parse(fs.readFileSync(hermesConfigPath(home), "utf8")) as {
        memory?: { provider?: string; other?: string };
        model?: string;
      };
      expect(cfg.memory?.provider).toBe("librarian");
      expect(cfg.memory?.other).toBe("keep");
      expect(cfg.model).toBe("x");
    });
  });

  it("uninstall: removes the dir + provider key, preserves unrelated config", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      setAdapterFetcher(fixtureFetcher(home));
      // Pre-existing unrelated config to preserve.
      fs.mkdirSync(path.dirname(hermesConfigPath(home)), { recursive: true });
      fs.writeFileSync(
        hermesConfigPath(home),
        JSON.stringify({ memory: { other: "keep" } }, null, 2),
        "utf8",
      );
      await hermes.install(CFG);
      await hermes.uninstall();

      expect(fs.existsSync(hermesPluginDir(home))).toBe(false);
      const cfg = JSON.parse(fs.readFileSync(hermesConfigPath(home), "utf8")) as {
        memory?: { provider?: string; other?: string };
      };
      expect(cfg.memory?.provider).toBeUndefined();
      expect(cfg.memory?.other).toBe("keep");
      await expect(hermes.detect()).resolves.toEqual({ installed: false });
    });
  });

  it("uninstall: no-op when nothing is installed", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      await expect(hermes.uninstall()).resolves.toBeUndefined();
    });
  });

  it("install via the real defaultFetcher: codeload tar extracts so detect() finds plugin.yaml", async () => {
    await withTempHome(async (home) => {
      setHomeOverride(home);
      // Use the REAL network fetcher (the default) but stub the HTTP GET so a
      // real codeload-shaped tarball is fed to the real `tar` extraction.
      resetAdapterFetcher();
      const bytes = await buildCodeloadTarball(PINNED_REF, "3.2.1");
      let requestedUrl: string | undefined;
      globalThis.fetch = (async (url: string | URL) => {
        requestedUrl = String(url);
        return new Response(bytes, { status: 200 });
      }) as typeof fetch;

      await hermes.install(CFG);

      // It fetched the pinned-ref codeload tarball.
      expect(requestedUrl).toContain(`/tar.gz/refs/tags/${PINNED_REF}`);

      // The adapter landed at the plugin-dir ROOT (not one level too deep):
      // ~/.hermes/plugins/librarian/plugin.yaml — NOT .../librarian/librarian/.
      expect(fs.existsSync(path.join(hermesPluginDir(home), "plugin.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(hermesPluginDir(home), "__init__.py"))).toBe(true);
      // Phase 2B: the auto-capture modules must land alongside the provider —
      // a dropped sibling .py would silently disable per-turn /transcript capture.
      expect(fs.existsSync(path.join(hermesPluginDir(home), "capture.py"))).toBe(true);
      expect(fs.existsSync(path.join(hermesPluginDir(home), "capture_state.py"))).toBe(true);
      expect(fs.existsSync(path.join(hermesPluginDir(home), "librarian", "plugin.yaml"))).toBe(
        false,
      );
      // Sibling repo files outside the adapter subtree were not extracted.
      expect(fs.existsSync(path.join(hermesPluginDir(home), "README.md"))).toBe(false);

      // The full round-trip: install stamps the copied plugin.yaml with the CLI
      // version (over the tarball's "3.2.1"), so detect reports cliVersion().
      await expect(hermes.detect()).resolves.toEqual({ installed: true, version: cliVersion() });
    });
  });

  it("PINNED_REF tracks the package version (so the adapter fetch can't 404)", () => {
    // The codeload tag we fetch the adapter from must be the tag THIS package
    // is published under — otherwise a fresh machine 404s on install.
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(PINNED_REF).toBe(`v${pkg.version}`);
  });
});
