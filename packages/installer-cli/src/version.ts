// Resolve the CLI's own version from its package.json.
//
// At runtime the built bin lives at `dist/bin.js`, so package.json is one
// directory up. Reading it (rather than baking the version in) keeps the
// reported version in lockstep with the published package — the phase gate
// owns the actual version bump.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function cliVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = fs.readFileSync(fileURLToPath(pkgUrl), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
