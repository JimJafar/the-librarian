// `the-librarian refs import <dir>` — file a folder of Markdown as references.
//
// The "point it at my Obsidian vault" case. Each file goes through the SAME
// import path as `refs add <file>` (importMarkdownFile), so there is one answer
// to "what does importing a Markdown file mean", not two that can drift.

import fs from "node:fs";
import path from "node:path";
import { type LibrarianStore, VaultFileExistsError } from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";
import { importMarkdownFile, isMarkdownPath, refsUsage } from "./refs-add.js";

/** Every Markdown file under `root`, as paths relative to it. Depth-first, sorted. */
export function findMarkdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      // Skip dot-directories: `.git`, `.obsidian` and friends are the tool's
      // own state, not the operator's reference material.
      if (entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile() && isMarkdownPath(entry.name)) found.push(relative);
    }
  };
  walk(root, "");
  return found;
}

export function refsImportCommand(
  store: LibrarianStore,
  positionals: string[],
  _flags: FlagMap,
): CliResult {
  const [target] = positionals;
  if (!target) return { stdout: refsUsage(), exitCode: 1 };

  const absoluteRoot = path.resolve(target);
  if (!fs.existsSync(absoluteRoot)) {
    return { stdout: `Error: ${target} not found.`, exitCode: 1 };
  }
  if (!fs.statSync(absoluteRoot).isDirectory()) {
    return {
      stdout: `Error: ${target} is a file — use 'the-librarian refs add ${target}'.`,
      exitCode: 1,
    };
  }

  const files = findMarkdownFiles(absoluteRoot);
  if (files.length === 0) {
    return { stdout: `No Markdown files found under ${target}.`, exitCode: 0 };
  }

  // D5: mirror the tree under the source folder's own name. A real folder
  // repeats filenames (several README.md), so flattening would collide — and a
  // collision is a skip, not an overwrite, which would mean content silently
  // never landing. Mirroring makes that impossible, within an import and
  // between separate imports.
  const folder = path.basename(absoluteRoot);
  const imported: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const relative of files) {
    const destination = `references/${folder}/${relative}`;
    try {
      importMarkdownFile(store, path.join(absoluteRoot, relative), destination);
      imported.push(destination);
    } catch (error) {
      // Already filed: the store's atomic create refuses rather than
      // overwriting. Caught rather than pre-checked, so there is no window
      // between "does it exist" and "write it".
      if (error instanceof VaultFileExistsError) skipped.push(destination);
      else failed.push(`${relative}: ${(error as Error).message}`);
    }
  }

  // Report every category. A silent skip reads as success, and the operator
  // would never learn that half their folder is missing.
  const lines = [`imported ${imported.length}, skipped ${skipped.length}`];
  if (skipped.length > 0) {
    lines.push("", "Already filed (left untouched):", ...skipped.map((p) => `  ${p}`));
  }
  if (failed.length > 0) {
    lines.push("", "Failed:", ...failed.map((f) => `  ${f}`));
  }
  return { stdout: lines.join("\n"), exitCode: failed.length > 0 ? 1 : 0 };
}
