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

/** A vault-relative operation would traverse a symbolic link below the configured vault root. */
export class UnsafeVaultPathError extends Error {
  constructor(relPath: string) {
    super(`vault: refusing path '${relPath}' because it traverses a symbolic link`);
    this.name = "UnsafeVaultPathError";
  }
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

  function assertNoSymbolicLinks(relPath: string, absPath: string): void {
    const relative = path.relative(root, absPath);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new UnsafeVaultPathError(relPath);
    }
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
    assertNoSymbolicLinks(fromRel, absFrom);
    assertNoSymbolicLinks(toRel, absTo);
    if (!fs.lstatSync(absFrom).isFile()) {
      throw new Error(`vault: move source '${fromRel}' is not a regular file`);
    }
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    // Recheck after mkdir: another local process must not be able to replace a
    // destination parent with a symlink between validation and creation.
    assertNoSymbolicLinks(toRel, absTo);

    // rename(2) overwrites an existing destination on POSIX. A hard link is an
    // atomic no-clobber create on the same vault filesystem; removing the old
    // name then completes a file move without a check/use overwrite race.
    // Filesystems without hard links (exFAT, most SMB/CIFS mounts) refuse
    // link(2) outright, so fall back to an exclusive copy there — COPYFILE_EXCL
    // keeps the no-clobber guarantee that motivated dropping rename(2).
    let created = false;
    try {
      try {
        fs.linkSync(absFrom, absTo);
      } catch (error) {
        if (!isHardLinkUnsupported(error)) throw error;
        fs.copyFileSync(absFrom, absTo, fs.constants.COPYFILE_EXCL);
      }
      created = true;
      fs.unlinkSync(absFrom);
    } catch (error) {
      if (created) {
        try {
          fs.unlinkSync(absTo);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "vault: move failed and the destination link could not be rolled back",
          );
        }
      }
      throw error;
    }
  }

  function isHardLinkUnsupported(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EINVAL";
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

/**
 * A SHELF-SCOPED view of a vault (spec 062 T3 / SC 3): every relative path the
 * returned {@link Vault} sees is confined BENEATH `prefix`. Reads/writes speak
 * SHELF-RELATIVE paths (`memories/foo.md`) which are transparently rooted under the
 * prefix on the way in (`<prefix>memories/foo.md`) and stripped back to shelf-relative
 * on the way out of listings — so a subdir-hardcoded sub-store (the markdown memory /
 * handoff stores, the inbox writer, the corpus-index builder, `searchReferences`) lands
 * its `memories/` · `handoffs/` · `inbox/` · `references/` layout under the shelf with
 * NO change to that sub-store. The single git repo is untouched: these sub-stores commit
 * through the ONE injected committer, never through the vault's `root`.
 *
 * `prefix` MUST be a validated shelf prefix (forward-slash, trailing slash, no
 * dot-segments — {@link validateShelfSet}). The EMPTY prefix is the vault root (the OSS
 * default shelf): this returns the vault UNCHANGED (identity), so the default-shelf handle
 * IS the legacy path — zero wrapping, byte-for-byte today's behaviour.
 */
export function scopeVault(vault: Vault, prefix: string): Vault {
  if (prefix === "") return vault; // the default shelf IS the vault — identity, one code path
  const scopedRoot = path.join(vault.root, prefix);
  // Defense-in-depth (review G2): a shelf-relative path must stay under `<root>/<prefix>`, mirroring
  // the underlying vault's own `within()` against the TRUE root. The underlying `within()` alone
  // only stops an escape from the whole vault — a `../…` rel could resolve OUT of this shelf into a
  // SIBLING shelf while remaining inside the repo (`members/x/` + `../../team/secret`). Guard the
  // shelf boundary here so a scoped handle can never cross into another shelf's subtree. The bound is
  // the scoped root with any trailing separator stripped (path.join keeps the prefix's trailing "/",
  // so compare against the normalised form — exactly as `within()` does with the true root).
  const scopedRootBound = scopedRoot.replace(/[\\/]+$/, "");
  const withinScope = (rel: string): void => {
    const abs = path.resolve(scopedRoot, rel);
    if (abs !== scopedRootBound && !abs.startsWith(scopedRootBound + path.sep)) {
      throw new Error(`vault: shelf-relative path '${rel}' escapes the shelf prefix '${prefix}'`);
    }
  };
  const toFull = (rel: string): string => {
    withinScope(rel);
    return prefix + rel;
  };
  const toShelf = (full: string): string =>
    full.startsWith(prefix) ? full.slice(prefix.length) : full;
  // LIST goes through the SAME boundary guard as every other accessor (review G2 follow-up): a
  // `subdir` is a shelf-relative path like any other, so `toFull` (not a bare `prefix + subdir`
  // concat) is what resolves it — otherwise `listMarkdown("../../team/references")` returned a SIBLING
  // shelf's listing, contradicting the guard's own invariant that a scoped handle can never cross into
  // another shelf's subtree. An absent subdir is the shelf root (`toFull("")` ⇒ the prefix), exactly as
  // before.
  const scopeList = (subdir: string | undefined, list: (s?: string) => string[]): string[] =>
    list(toFull(subdir ?? "")).map(toShelf);
  return {
    root: scopedRoot,
    writeText: (rel, content) => vault.writeText(toFull(rel), content),
    readText: (rel) => vault.readText(toFull(rel)),
    tryReadText: (rel) => vault.tryReadText(toFull(rel)),
    writeDocument: (rel, doc) => vault.writeDocument(toFull(rel), doc),
    readDocument: (rel) => vault.readDocument(toFull(rel)),
    tryReadDocument: (rel) => vault.tryReadDocument(toFull(rel)),
    listMarkdown: (subdir) => scopeList(subdir, (s) => vault.listMarkdown(s)),
    listFiles: (subdir) => scopeList(subdir, (s) => vault.listFiles(s)),
    moveFile: (fromRel, toRel) => vault.moveFile(toFull(fromRel), toFull(toRel)),
    removeFile: (rel) => vault.removeFile(toFull(rel)),
    exists: (rel) => vault.exists(toFull(rel)),
  };
}
