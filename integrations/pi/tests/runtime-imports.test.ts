// Pi loads a git/local-installed package WITHOUT `npm install`ing it, so at
// runtime an extension can only resolve relative paths, `node:` builtins, and
// the one specifier Pi's loader aliases in every distribution: `typebox`.
// Anything else (including value imports of `@earendil-works/*`) fails with
// `Cannot find module …` on some installs — and the vitest run won't catch it
// because tests execute WITH node_modules present. This guard greps instead.
// (Port of the standalone repo's scripts/check-imports.mjs, in vitest form.)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXTENSIONS_DIR = fileURLToPath(new URL("../extensions", import.meta.url));

// Value imports/exports with a module specifier. `import type` / `export type`
// are erased at runtime and explicitly skipped.
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\s)[^"']*?from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+["']([^"']+)["']/gm;

function isAllowed(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("node:") ||
    specifier === "typebox"
  );
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("runtime import guard (extensions/ must load with no node_modules)", () => {
  it("every value import resolves to typebox, node:, or a relative path", () => {
    const violations: string[] = [];
    for (const file of tsFiles(EXTENSIONS_DIR)) {
      const source = readFileSync(file, "utf8");
      for (const re of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
        re.lastIndex = 0;
        for (const match of source.matchAll(re)) {
          const specifier = match[1]!;
          if (!isAllowed(specifier)) violations.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
