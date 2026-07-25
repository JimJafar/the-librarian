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
  type UrlCaptureDeps,
  processUrlCapture,
  recordPending,
  renderImportedReference,
  slugifyTitle,
} from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

/** http(s) only — everything else is a path, and the guard rejects other schemes. */
function isHttpUrl(target: string): boolean {
  try {
    const { protocol } = new URL(target);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Fetch a URL and file it as a reference, reusing the capture pipeline the
 * browser and phone clippers already run through — SSRF-guarded fetch, Defuddle
 * extraction, slug, URL dedup, committing write, capture log.
 *
 * `deps` exists only so a test can stand in for the network; production passes
 * nothing and gets the real guard. Exported for that reason, and because the
 * happy path cannot be exercised through the CLI without it: a local stub
 * server would (correctly) be refused by the guard.
 */
export async function addUrlReference(
  store: LibrarianStore,
  url: string,
  deps?: UrlCaptureDeps,
): Promise<CliResult> {
  const id = recordPending(store, { source: url, via: "cli" });
  // processUrlCapture is FAIL-SOFT by design — it normally runs in a background
  // turn after /ingest has already returned 202, so it records failures instead
  // of throwing. A CLI caller is waiting on the result, so translate that into a
  // real exit code rather than cheerfully reporting success.
  const result = await processUrlCapture(store, { url, via: "cli" }, id, deps ?? {});
  if (result.status === "failed") {
    return {
      stdout: `Error: could not capture ${url} — ${result.error ?? "unknown error"}`,
      exitCode: 1,
    };
  }
  return { stdout: `Filed ${result.path}`, exitCode: 0 };
}

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

export async function refsAddCommand(
  store: LibrarianStore,
  positionals: string[],
  flags: FlagMap,
): Promise<CliResult> {
  // `--move` is a known switch in the parser (BOOLEAN_FLAGS), so it never
  // consumes the path and works on either side of the filename.
  const [target] = positionals;
  const shouldMove = flags.move === true;

  if (!target) return { stdout: refsUsage(), exitCode: 1 };

  // A URL goes down the fetch pipeline; anything else is a path. Checked BEFORE
  // the filesystem so a URL is never mistaken for a missing file.
  if (isHttpUrl(target)) {
    if (shouldMove) {
      return { stdout: "Error: --move applies to a local file, not a URL.", exitCode: 1 };
    }
    return await addUrlReference(store, target);
  }
  // A scheme we don't fetch (file://, ftp://, …). Say so plainly: without this
  // it falls through to the path arm and reports "not found", which sends the
  // operator looking for a missing file instead of telling them the truth.
  // Matched on `scheme://` so a Windows drive path (`C:\notes`) is unaffected.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return {
      stdout: `Error: refs add fetches http(s) URLs only — ${target} uses an unsupported scheme.`,
      exitCode: 1,
    };
  }

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
    "  add <file.md|url>             File a Markdown file or a web page as a reference",
    "  import <dir>                  File every Markdown file under a folder",
    "",
    "Flags:",
    "  --move                        add: remove the source file once it is filed",
  ].join("\n");
}
