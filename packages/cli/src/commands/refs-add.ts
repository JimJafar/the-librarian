// `the-librarian refs add <file|url> [--move]` — file a reference.
//
// References are a third of the product's promise ("upload a spec once and
// every agent can search it"), and until spec 073 the only ways in were the
// browser/phone clippers and hand-writing a vault file. This is the operator's
// door.
//
// The file arm keeps the source file's own frontmatter (D4) — importing a
// folder of notes must not silently discard the `tags` and titles that made
// them worth keeping.

import fs from "node:fs";
import path from "node:path";
import {
  SYSTEM_ACTOR_IDS,
  type LibrarianStore,
  renderImportedReference,
  slugifyTitle,
} from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

/** Extensions we accept as Markdown. PDF is deliberately out (spec 073 §3). */
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Import one Markdown file as a reference. Returns the vault-relative path it
 * was filed at.
 *
 * Exported so `refs import` files each of its files through exactly this path —
 * one implementation of "what it means to import a Markdown file", not two.
 */
export function importMarkdownFile(
  store: LibrarianStore,
  absolutePath: string,
  destination: string,
  now: () => string = () => new Date().toISOString(),
): { path: string } {
  const raw = fs.readFileSync(absolutePath, "utf8");
  const document = renderImportedReference({
    raw,
    via: "cli",
    capturedAt: now(),
    source: absolutePath,
    fallbackTitle: path.basename(absolutePath, path.extname(absolutePath)),
  });
  // The committing store write: path checks, atomic create, one git commit
  // carrying the actor trailer. Never a raw fs write into the vault.
  store.vaultFiles.createFile(destination, document, SYSTEM_ACTOR_IDS.cli);
  return { path: destination };
}

/** `references/<slug>.md` — the slug derived from the file's title or name. */
export function destinationForFile(absolutePath: string): string {
  const raw = fs.readFileSync(absolutePath, "utf8");
  const titleLine = /^title:\s*(.+?)\s*$/m.exec(raw.split(/^---\s*$/m)[1] ?? "");
  const basename = path.basename(absolutePath, path.extname(absolutePath));
  return `references/${slugifyTitle(titleLine?.[1] ?? basename)}.md`;
}

export function refsAddCommand(
  store: LibrarianStore,
  positionals: string[],
  flags: FlagMap,
): CliResult {
  // The shared parser (parse-flags.ts) treats the argument after `--move` as
  // that flag's VALUE whenever it isn't another flag, so `refs add --move a.md`
  // arrives as `{ move: "a.md" }` with no positional at all. Recover the path
  // rather than making flag ORDER load-bearing — an operator should not have to
  // know which side of the filename the flag belongs on.
  const swallowedPath = typeof flags.move === "string" ? flags.move : null;
  const target = positionals[0] ?? swallowedPath ?? undefined;
  const shouldMove = flags.move === true || swallowedPath !== null;

  if (!target) return { stdout: refsUsage(), exitCode: 1 };

  const absolutePath = path.resolve(target);
  if (!fs.existsSync(absolutePath)) {
    return { stdout: `Error: ${target} not found.`, exitCode: 1 };
  }
  if (fs.statSync(absolutePath).isDirectory()) {
    return {
      stdout: `Error: ${target} is a directory — use 'the-librarian refs import ${target}'.`,
      exitCode: 1,
    };
  }
  if (!isMarkdownPath(absolutePath)) {
    return {
      stdout: `Error: ${target} is not Markdown — refs add takes a .md file or a URL.`,
      exitCode: 1,
    };
  }

  let filed: { path: string };
  try {
    filed = importMarkdownFile(store, absolutePath, destinationForFile(absolutePath));
  } catch (error) {
    return { stdout: `Error: ${(error as Error).message}`, exitCode: 1 };
  }

  // --move (D8): unlink STRICTLY AFTER the commit has landed. Doing it any
  // earlier would lose the operator's file on a failed write — which is the
  // whole reason this flag is opt-in.
  const lines = [`Filed ${filed.path}`];
  if (shouldMove) {
    try {
      fs.unlinkSync(absolutePath);
      lines.push(`Removed ${absolutePath}`);
    } catch (error) {
      // The reference IS filed; failing to tidy up is not a failed import.
      lines.push(`Filed, but could not remove ${absolutePath}: ${(error as Error).message}`);
    }
  }
  return { stdout: lines.join("\n"), exitCode: 0 };
}

export function refsUsage(): string {
  return [
    "Usage: the-librarian refs <verb> [args] [flags]",
    "",
    "Verbs:",
    "  add <file.md>                 File a local Markdown file as a reference",
    "",
    "Flags:",
    "  --move                        add: remove the source file once it is filed",
  ].join("\n");
}
