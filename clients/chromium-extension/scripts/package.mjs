// Zip the built `dist/` into a release artifact for load-unpacked / GitHub-release
// distribution (D28). Run `pnpm build` first. Uses the system `zip` (present on
// macOS + Linux CI); errors with a teaching message if the build is missing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dist = path.join(root, "dist");
const releaseDir = path.join(root, "release");
const zipPath = path.join(releaseDir, "librarian-chromium-extension.zip");

if (!existsSync(path.join(dist, "manifest.json"))) {
  console.error(
    "No build found in dist/. Run `pnpm --filter @librarian/chromium-extension build` first.",
  );
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
rmSync(zipPath, { force: true });

// `zip -r <out> .` from inside dist/ so the archive has no `dist/` prefix.
execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: dist, stdio: "inherit" });

console.log(`Packaged → ${path.relative(root, zipPath)}`);
