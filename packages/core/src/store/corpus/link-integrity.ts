// Vault-wide link integrity (spec 035 §F12). When a document is renamed,
// every wikilink that points at it — in any form, in any document — must be
// rewritten so no link dangles. This is the link-integrity half of F12; the
// move of the document's own file is the caller's `vault.moveFile`, and
// persisting the result is the caller's `git.commitAll` (commit-per-op).
//
// Link targets are bare ids (the intake's convention — slugs unique
// across the vault, matching Obsidian's shortest-unique-path default), so
// relinking matches `[[id]]` rather than path-form links.

import type { Vault } from "./vault.js";
import { renameWikilinkTarget } from "./wikilink.js";

/**
 * Rewrite every wikilink whose target equals `from` to `to` across the
 * whole vault (all forms), writing back only the documents that changed.
 * Returns the changed file paths (posix-relative to the vault root, sorted).
 */
export function relinkVault(vault: Vault, from: string, to: string): string[] {
  const changed: string[] = [];
  for (const relPath of vault.listMarkdown()) {
    const document = vault.readDocument(relPath);
    const body = renameWikilinkTarget(document.body, from, to);
    if (body === document.body) continue;
    vault.writeDocument(relPath, { ...document, body });
    changed.push(relPath);
  }
  return changed;
}
