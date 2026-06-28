// Bundle the extension into `dist/` as a loadable unpacked Chromium MV3 build.
//
// Each entry is bundled as a self-contained IIFE (no ESM imports at runtime):
// content scripts are classic scripts, and bundling the SW + page scripts the
// same way keeps Defuddle and the shared lib inlined with zero loader concerns.
// Static assets (manifest, html, icons) are copied verbatim.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "dist");
const production = process.env.NODE_ENV === "production";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [
    path.join(here, "src/content-script.ts"),
    path.join(here, "src/background.ts"),
    path.join(here, "src/options.ts"),
    path.join(here, "src/popup.ts"),
  ],
  bundle: true,
  format: "iife",
  target: ["chrome111", "edge111"],
  platform: "browser",
  outdir,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

// Icons are committed brand assets (the Librarian curator mark, sourced from the
// dashboard's brand PNGs) — not generated. Fail loudly if one is missing rather
// than silently shipping a placeholder.
for (const size of [16, 32, 48, 128]) {
  if (!existsSync(path.join(here, `static/icons/icon${size}.png`))) {
    throw new Error(`Missing committed brand icon: static/icons/icon${size}.png`);
  }
}

cpSync(path.join(here, "static"), outdir, { recursive: true });
cpSync(path.join(here, "manifest.json"), path.join(outdir, "manifest.json"));

console.log(`Built unpacked extension → ${path.relative(here, outdir)}/`);
