// Build a PRODUCTION bundle (minified, NO source maps) and zip dist/ into a
// release artifact for the Chrome / Edge web stores + load-unpacked distribution
// (D28). Run via `pnpm --filter @librarian/chromium-extension package`. Uses the
// system `zip` (present on macOS + Linux CI).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dist = path.join(root, "dist");
const releaseDir = path.join(root, "release");
const zipPath = path.join(releaseDir, "librarian-chromium-extension.zip");

// Force a production build so the store/release zip never ships `.map` files or
// unminified source. The esbuild config reads NODE_ENV at import time (minify on,
// sourcemap off when production) and rebuilds dist/ from scratch.
process.env.NODE_ENV = "production";
await import("../esbuild.config.mjs");

if (!existsSync(path.join(dist, "manifest.json"))) {
  console.error("Production build did not produce dist/manifest.json.");
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
rmSync(zipPath, { force: true });

// `zip -r <out> .` from inside dist/ so the archive has manifest.json at the root
// (no `dist/` prefix), as the Chrome Web Store requires.
execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: dist, stdio: "inherit" });

console.log(`Packaged (production) → ${path.relative(root, zipPath)}`);
