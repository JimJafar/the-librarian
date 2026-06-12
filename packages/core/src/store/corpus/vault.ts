// Vault file I/O for the markdown corpus (spec 035 §F1 / Project
// Structure). The vault is a folder of Obsidian-flavoured markdown at
// `<data-dir>/vault` (or `LIBRARIAN_VAULT_PATH`), laid out as `inbox/`,
// topic folders, `references/`, `handoffs/`, `archive/`. This
// module is the read/write/list/move primitive the git-ops +
// link-integrity service (next increment) commits on top of.
//
// The corpus layer stays free of the store graph (component map:
// corpus → no deps), so the tiny data-dir resolution is inlined here
// rather than imported from `librarian-store`.

import fs from "node:fs";
import path from "node:path";
import { type CorpusDocument, parseDocument, serializeDocument } from "./frontmatter.js";

export interface VaultOptions {
  /** Explicit vault directory; wins over env + dataDir. */
  vaultPath?: string;
  /** Data dir to derive `<dataDir>/vault` from when no explicit/env path. */
  dataDir?: string;
  /**
   * Eagerly create the vault root dir (default true). Pass false for a
   * read-only consumer that must not materialize the dir when it's absent —
   * reads tolerate a missing root, and writes still create parent folders on
   * demand.
   */
  create?: boolean;
}

/**
 * Resolve the vault directory: an explicit `vaultPath` wins, then
 * `LIBRARIAN_VAULT_PATH`, then `<dataDir>/vault` (dataDir itself resolving
 * via `LIBRARIAN_DATA_DIR` / `<cwd>/data`).
 *
 * Always ABSOLUTE: `within()`'s escape check resolves a relative path to an
 * absolute one and compares it against `root`, so a relative `root` (e.g. a
 * `--data-dir ./x`) would make every subpath look like an escape. Callers that
 * route through `resolveDataDir` already pass an absolute dir; this guards the
 * ones (like the seed script) that don't.
 */
export function resolveVaultPath(options: VaultOptions = {}): string {
  if (options.vaultPath) return path.resolve(options.vaultPath);
  if (process.env.LIBRARIAN_VAULT_PATH) return path.resolve(process.env.LIBRARIAN_VAULT_PATH);
  const dataDir =
    options.dataDir || process.env.LIBRARIAN_DATA_DIR || path.join(process.cwd(), "data");
  return path.resolve(dataDir, "vault");
}

export interface Vault {
  /** Absolute path of the vault root. */
  readonly root: string;
  /** Write raw markdown text (creating parent folders). */
  writeText(relPath: string, content: string): void;
  /** Read raw markdown text; throws a teaching error when absent. */
  readText(relPath: string): string;
  tryReadText(relPath: string): string | null;
  writeDocument(relPath: string, doc: CorpusDocument): void;
  /** Read + parse a corpus-minimal document; throws a teaching error when absent. */
  readDocument(relPath: string): CorpusDocument;
  tryReadDocument(relPath: string): CorpusDocument | null;
  /** Recursive list of `.md` files (posix-relative to the root, sorted). */
  listMarkdown(subdir?: string): string[];
  /** Recursive list of ALL files (any extension; posix-relative to the root, sorted). */
  listFiles(subdir?: string): string[];
  /** Move a file within the vault — the archive=move (reversible) primitive. */
  moveFile(fromRel: string, toRel: string): void;
  /**
   * Hard-delete a file. The vault's rule is archive=move (never destroy
   * knowledge); this is the narrow admin/test exception (e.g. handoff
   * `purge`). Idempotent — a no-op when the file is absent.
   */
  removeFile(relPath: string): void;
  exists(relPath: string): boolean;
}

export function createVault(options: VaultOptions = {}): Vault {
  const root = resolveVaultPath(options);
  if (options.create !== false) fs.mkdirSync(root, { recursive: true });

  // Resolve a vault-relative path to an absolute one, refusing anything
  // that escapes the root — the vault is `git push`ed, so a stray `..`
  // write must never land outside it.
  function within(relPath: string): string {
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`vault: path '${relPath}' escapes the vault root`);
    }
    return abs;
  }

  function exists(relPath: string): boolean {
    return fs.existsSync(within(relPath));
  }

  function writeText(relPath: string, content: string): void {
    const abs = within(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  function readText(relPath: string): string {
    const abs = within(relPath);
    if (!fs.existsSync(abs)) throw new Error(`vault: no document at '${relPath}'`);
    return fs.readFileSync(abs, "utf8");
  }

  function tryReadText(relPath: string): string | null {
    return exists(relPath) ? readText(relPath) : null;
  }

  function writeDocument(relPath: string, doc: CorpusDocument): void {
    writeText(relPath, serializeDocument(doc));
  }

  function readDocument(relPath: string): CorpusDocument {
    return parseDocument(readText(relPath));
  }

  function tryReadDocument(relPath: string): CorpusDocument | null {
    return exists(relPath) ? readDocument(relPath) : null;
  }

  function listWithin(subdir: string | undefined, keep: (name: string) => boolean): string[] {
    const base = subdir ? within(subdir) : root;
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return []; // missing, or a file
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && keep(entry.name)) {
          out.push(path.relative(root, abs).split(path.sep).join("/"));
        }
      }
    };
    walk(base);
    return out.sort();
  }

  function listMarkdown(subdir?: string): string[] {
    return listWithin(subdir, (name) => name.endsWith(".md"));
  }

  function listFiles(subdir?: string): string[] {
    return listWithin(subdir, () => true);
  }

  function moveFile(fromRel: string, toRel: string): void {
    const absFrom = within(fromRel);
    const absTo = within(toRel);
    if (!fs.existsSync(absFrom)) throw new Error(`vault: no file to move at '${fromRel}'`);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(absFrom, absTo);
  }

  function removeFile(relPath: string): void {
    fs.rmSync(within(relPath), { force: true });
  }

  return {
    root,
    writeText,
    readText,
    tryReadText,
    writeDocument,
    readDocument,
    tryReadDocument,
    listMarkdown,
    listFiles,
    moveFile,
    removeFile,
    exists,
  };
}
