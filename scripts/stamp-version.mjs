#!/usr/bin/env node
// Keep the PUBLIC workspace packages' versions in lockstep with the root
// package.json — the single source of truth that every PR bumps and the Release
// workflow tags.
//
// Why this exists: `@the-librarian/cli` (packages/installer-cli) is published to
// npm, but the "bump the root package.json" release model only versioned the
// root. The published package's own version drifted (frozen at rc.5 while the
// root advanced to rc.20+), so the publish step kept reading the stale version,
// saw it already on npm, and silently no-op'd — npm froze at rc.5 while GitHub
// releases marched on. The Release workflow runs this before `npm publish` so the
// published artifact always matches the tag; `pnpm sync:versions` runs it locally
// so a source build's `librarian --version` is honest too.
//
// Private packages (private:true, pinned at 0.0.0) are deliberately left alone.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/**
 * Given a package.json's raw text and the canonical root version, return the
 * rewritten text with `version` set to `rootVersion`, or `null` when nothing
 * should change — the package is private (stays pinned at 0.0.0) or is already at
 * the version. Preserves the repo's package.json style (2-space indent + trailing
 * newline). Exported (pure) so it is unit-tested without touching the filesystem.
 */
export function stampPackageJson(raw, rootVersion) {
  const pkg = JSON.parse(raw);
  if (pkg.private === true) return null;
  if (pkg.version === rootVersion) return null;
  pkg.version = rootVersion;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Stamp every public package under `packages/` to the root version. Returns the
 * root version and the list of package dirs that changed.
 */
export function stampAll(root = repoRoot) {
  const rootVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const packagesDir = path.join(root, "packages");
  const changed = [];
  for (const entry of fs.readdirSync(packagesDir)) {
    const file = path.join(packagesDir, entry, "package.json");
    if (!fs.existsSync(file)) continue;
    const next = stampPackageJson(fs.readFileSync(file, "utf8"), rootVersion);
    if (next === null) continue;
    fs.writeFileSync(file, next);
    changed.push(entry);
  }
  return { rootVersion, changed };
}

// CLI entrypoint (run directly, not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { rootVersion, changed } = stampAll();
  console.log(
    changed.length
      ? `[stamp-version] set ${changed.join(", ")} to ${rootVersion}.`
      : `[stamp-version] all public packages already at ${rootVersion}.`,
  );
}
