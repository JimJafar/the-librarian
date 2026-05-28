// Single source of truth for the running build's version string.
//
// We read the root `package.json` at module load — it lives one directory
// above the workspace, so the relative walk is deterministic from the
// installed mcp-server's `dist/` location too. The value is exposed to the
// dashboard via the `health.info` tRPC procedure (and to anything else that
// needs it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0+unknown";

function findRootPackageJson(): string | null {
  // From `packages/mcp-server/src/version.ts` (or `dist/version.js`) walk up
  // to the repo root and read package.json. Stop at the filesystem root.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: unknown };
        // The root package's `name` is `the-librarian`; workspace packages
        // are `@librarian/*`. Skip the workspace `package.json` we'd hit
        // on the way up.
        if (parsed.name === "the-librarian") return candidate;
      } catch {
        /* ignore unreadable / non-JSON */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readRootVersion(): string {
  const root = findRootPackageJson();
  if (!root) return FALLBACK_VERSION;
  try {
    const parsed = JSON.parse(fs.readFileSync(root, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export const PACKAGE_VERSION: string = readRootVersion();
