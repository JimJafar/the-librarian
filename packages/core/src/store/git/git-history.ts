// Git history surface for the vault (rethink T20/T21, spec §8 / D16) — the
// plumbing behind the dashboard's per-file history / diff / restore, the
// vault-wide activity feed, and the guarded whole-vault restore. Same
// posture as sync-git-ops: shell out to `git` synchronously via
// child_process (no new deps), stderr piped so probe noise stays off the
// console, and every revision/tag argument validated before it reaches
// argv (a hash that isn't plain hex could otherwise smuggle a flag).
//
// `fileHistory` follows renames (`git log --follow`) and reports the path
// the file had AT each commit, so `fileAtCommit`/`fileDiff` can address
// pre-rename versions by the name they were committed under.

import { execFileSync } from "node:child_process";

/** A revision argument that is not a plain abbreviated/full hex hash. */
export class GitHashError extends Error {}

/**
 * Validate a caller-supplied revision: 7–40 hex chars, nothing else — never a
 * ref name, range, or anything flag-shaped. Returns the lowercased hash.
 */
export function assertCommitHash(hash: string): string {
  if (typeof hash !== "string" || !/^[0-9a-f]{7,40}$/i.test(hash)) {
    throw new GitHashError(
      `expected a git commit hash (7-40 hex characters), got '${String(hash)}'`,
    );
  }
  return hash.toLowerCase();
}

/** git's well-known empty tree — diffing from it renders a file as all-additions. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Output framing for the parsed log formats: \x1e separates commits,
// \x1f separates fields — neither can occur in git's %H/%aI/%an/%s output.
const RS = "\x1e";
const US = "\x1f";

/** One commit in a file's history (`git log --follow`). */
export interface FileCommit {
  /** Full commit hash. */
  hash: string;
  /** Author date, ISO-8601. */
  date: string;
  /** Author name (the vault's single committer identity; provenance lives in the subject). */
  author: string;
  /** Commit subject line. */
  subject: string;
  /** The file's vault-relative path AT this commit (differs across renames). */
  path: string;
}

export interface GitHistoryFileDiffOptions {
  /** Older side; omitted → the empty tree (the whole file renders as additions). */
  from?: string;
  /** Newer side; omitted → the working tree (the file's current content). */
  to?: string;
  /** The file's path at `from`, when a rename means it differs from `relPath`. */
  fromPath?: string;
}

/** One commit in the vault-wide activity feed (rethink T21). */
export interface VaultCommit {
  /** Full commit hash. */
  hash: string;
  /** Author date, ISO-8601. */
  date: string;
  /** Author name. */
  author: string;
  /** Commit subject line — the provenance carrier (`memory:`, `vault:`, …). */
  subject: string;
  /**
   * Vault-relative paths this commit touched — kept as BARE post-rename paths (a rename reports
   * only its destination, unchanged from the pre-064 `--name-only` shape the dashboard activity
   * feed consumes; spec 064 SC 10). The rename PAIRS live in {@link VaultCommit.renames}.
   */
  files: string[];
  /**
   * Rename pairs (`--name-status -M` `R` rows), source → destination (spec 064 SC 10). A SEPARATE
   * field so `files` keeps its bare shape; the audit export turns a cross-shelf rename into a
   * departure/arrival pair from these. Empty for a commit with no renames.
   */
  renames: { from: string; to: string }[];
}

/**
 * One vault commit as the AUDIT export reads it (spec 064 T7/T8). It carries the raw
 * `Librarian-Actor` trailer values — ALL of them, so the reader can apply "≠1 → null" (SC 7c) —
 * plus the rename pairs, and is read with `core.quotePath=false` so a non-ASCII path is never
 * C-quoted out of the shelf filter (SC 9b). Distinct from {@link VaultCommit} so the activity
 * feed's published shape is untouched.
 */
export interface AuditCommit {
  hash: string;
  /** Author date, ISO-8601. */
  date: string;
  subject: string;
  /** Bare post-rename paths (same shape as {@link VaultCommit.files}). */
  files: string[];
  /** Rename pairs, source → destination. */
  renames: { from: string; to: string }[];
  /** Every `Librarian-Actor` trailer value (0, 1, or — a forgery/duplicate — more; SC 7c). */
  actors: string[];
}

/**
 * The outcome of an audit read (spec 064 SC 11), the three legitimate states kept DISTINCT from a
 * source failure so the store can raise a typed CLIENT error for a bad cursor and an
 * `AuditSourceError` for a broken repo — `git-history` historically collapsed all three to `[]`.
 * A pure data result: the audit-domain error taxonomy lives in `audit-export.ts`, so git-history
 * owns no audit types.
 */
export type AuditReadResult =
  | { kind: "ok"; commits: AuditCommit[] }
  | { kind: "empty" } // a commitless repo — an empty page, not an error
  | { kind: "unknown-cursor" } // `before` is valid hex but names no commit
  | { kind: "unreadable"; detail: string }; // broken `.git` / an unexpected git failure

/** One file's change in a commit's diff. */
export interface CommitDiffFile {
  /** The file's path AT this commit (post-rename for R rows). */
  path: string;
  /** Whether the commit added / modified / deleted / renamed the file. */
  status: "added" | "modified" | "deleted" | "renamed";
  /** The file's pre-rename path when `status === "renamed"`; otherwise omitted. */
  fromPath?: string;
  /** Unified diff text for this file in this commit. Empty when binary or
   *  rename-only with no content change. */
  diff: string;
}

/** Per-file diffs for the change introduced by a single commit (rethink T21
 *  audit-trail accordion). */
export interface CommitDiff {
  /** Full commit hash. */
  hash: string;
  /** Per-file changes; order matches git's diff-tree output (rename-sensitive). */
  files: CommitDiffFile[];
}

export interface GitHistory {
  /**
   * Every commit that touched `relPath`, newest first, following renames.
   * Empty for an unknown path or a commitless repo.
   */
  fileHistory(relPath: string): FileCommit[];
  /**
   * The file's content at `hash` (addressed by the path it had at that
   * commit), or `null` when the path has no blob there.
   */
  fileAtCommit(relPath: string, hash: string): string | null;
  /**
   * Unified diff text for one file between two points in history (see
   * GitHistoryFileDiffOptions for the from/to defaults). Empty string when
   * the versions are identical.
   */
  fileDiff(relPath: string, options?: GitHistoryFileDiffOptions): string;
  /**
   * The newest `limit` vault commits with the files each touched (rethink
   * T21 activity feed). `before` pages: only commits strictly older than
   * that commit are returned. Empty on a commitless repo.
   */
  recentCommits(options?: { limit?: number; before?: string }): VaultCommit[];
  /**
   * The audit export's read (spec 064 T7/T8): the newest `limit` commits (older than `before`)
   * with their rename pairs AND every `Librarian-Actor` trailer, read with `core.quotePath=false`
   * (SC 9b). UNLIKE {@link recentCommits} it does NOT collapse every failure to `[]` — it returns a
   * discriminated {@link AuditReadResult} so the caller can tell a commitless repo (an empty page)
   * from an unknown cursor (a client error) from a broken `.git` (a source error).
   */
  auditCommits(options?: { limit?: number; before?: string }): AuditReadResult;
  /**
   * Per-file diffs for the change introduced by `hash` (rethink T21
   * activity-feed accordion). One `git show` invocation under the hood;
   * sections split on the `diff --git` header. Throws for an unknown hash.
   */
  commitDiff(hash: string): CommitDiff;
  /** Does this hash name a commit in the repo? */
  commitExists(hash: string): boolean;
  /**
   * Create a lightweight tag named `name` on the current HEAD (the
   * pre-restore safety anchor). Throws when the name is taken.
   */
  tag(name: string): void;
  /**
   * Make the index + working tree match `hash`'s tree exactly — files added
   * since are removed, changed files reverted. STAGES ONLY; the caller owns
   * the commit (the whole-vault restore commits it as ONE new commit).
   */
  restoreTreeTo(hash: string): void;
}

export function createGitHistory(opts: { cwd: string }): GitHistory {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const tryGit = (args: string[]): string | null => {
    try {
      return git(args);
    } catch {
      return null;
    }
  };

  function fileHistory(relPath: string): FileCommit[] {
    // --name-status rides along so each commit reports the path the file had
    // THERE: a rename row (`R<score>\told\tnew`) names both sides; -M keeps
    // rename detection on for the row shape to be stable.
    const out = tryGit([
      "log",
      "--follow",
      "-M",
      "--name-status",
      `--format=${RS}%H${US}%aI${US}%an${US}%s`,
      "--",
      relPath,
    ]);
    if (out === null) return []; // commitless repo
    const commits: FileCommit[] = [];
    for (const block of out.split(RS)) {
      if (!block.trim()) continue;
      const lines = block.split("\n").filter((line) => line.length > 0);
      const [header, ...statusLines] = lines;
      const [hash, date, author, subject] = (header ?? "").split(US);
      if (!hash || !date) continue;
      commits.push({
        hash,
        date,
        author: author ?? "",
        subject: subject ?? "",
        path: pathAtCommit(statusLines) ?? relPath,
      });
    }
    return commits;
  }

  function fileAtCommit(relPath: string, hash: string): string | null {
    return tryGit(["show", `${assertCommitHash(hash)}:${relPath}`]);
  }

  function fileDiff(relPath: string, options: GitHistoryFileDiffOptions = {}): string {
    const from = options.from === undefined ? EMPTY_TREE : assertCommitHash(options.from);
    const revs = options.to === undefined ? [from] : [from, assertCommitHash(options.to)];
    // The pathspec carries the pre-rename name too, so a diff that crosses the
    // rename still sees both sides (and -M renders it as a rename, not del+add).
    const paths =
      options.fromPath && options.fromPath !== relPath ? [relPath, options.fromPath] : [relPath];
    return tryGit(["diff", "-M", ...revs, "--", ...paths]) ?? "";
  }

  function recentCommits(options: { limit?: number; before?: string } = {}): VaultCommit[] {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const before = options.before === undefined ? undefined : assertCommitHash(options.before);
    // Page cursor: log starting AT the cursor commit, then drop it — page N's
    // last entry must not reappear as page N+1's first.
    const out = tryGit([
      // Never C-quote a non-ASCII path (spec 064 SC 9b): the feed renders the true filename, and
      // — since the audit export shares this shape — a shelf prefix match is never broken by a
      // leading `"`.
      "-c",
      "core.quotePath=false",
      "log",
      `-${before === undefined ? limit : limit + 1}`,
      // `--name-status -M` exposes rename PAIRS (`R<score>\told\tnew`) so promotion is visible;
      // the parser keeps `files` bare (the `R`-row destination), reproducing the pre-064
      // `--name-only` shape (spec 064 SC 10).
      "--name-status",
      "-M",
      `--format=${RS}%H${US}%aI${US}%an${US}%s`,
      ...(before === undefined ? [] : [before]),
      // Terminator: forces the cursor to parse as a revision, so a committed
      // FILE named like the hash can't make the argument ambiguous (git would
      // error and the feed would silently come back empty).
      "--",
    ]);
    if (out === null) return []; // commitless repo / unknown cursor
    const commits: VaultCommit[] = [];
    for (const block of out.split(RS)) {
      if (!block.trim()) continue;
      const lines = block.split("\n").filter((line) => line.length > 0);
      const [header, ...statusLines] = lines;
      const [hash, date, author, subject] = (header ?? "").split(US);
      if (!hash || !date) continue;
      const { files, renames } = parseNameStatus(statusLines);
      commits.push({ hash, date, author: author ?? "", subject: subject ?? "", files, renames });
    }
    if (before !== undefined && commits[0]?.hash.startsWith(before)) commits.shift();
    return commits.slice(0, limit);
  }

  function auditCommits(options: { limit?: number; before?: string } = {}): AuditReadResult {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const before = options.before === undefined ? undefined : assertCommitHash(options.before);
    // Distinguish a commitless repo from a broken one — `tryGit`→[] cannot. `rev-parse --verify
    // --quiet HEAD` prints the hash + exits 0 with commits, exits 1 SILENTLY on a commitless repo,
    // and exits 128 ("not a git repository") on a broken one.
    let hasCommits: boolean;
    try {
      hasCommits = git(["rev-parse", "--verify", "--quiet", "HEAD"]).trim().length > 0;
    } catch (error) {
      if ((error as { status?: number }).status === 1) return { kind: "empty" };
      return { kind: "unreadable", detail: gitErrorText(error) };
    }
    if (!hasCommits) return { kind: "empty" };
    if (before !== undefined && !commitExists(before)) return { kind: "unknown-cursor" };
    let out: string;
    try {
      out = git([
        "-c",
        "core.quotePath=false", // SC 9b: a non-ASCII path must never be C-quoted out of the filter
        "log",
        `-${before === undefined ? limit : limit + 1}`,
        "--name-status",
        "-M",
        // The `Librarian-Actor` trailer values ride the header line as trailing US-separated
        // fields (keyed + valueonly stays ON the header line; the bare `%(trailers)` would put
        // each on its own line and be ingested as a filename). 0 values → one trailing empty
        // field; ≥2 → multiple fields, which the reader treats as `actor: null` (SC 7c).
        `--format=${RS}%H${US}%aI${US}%s${US}%(trailers:key=Librarian-Actor,valueonly,separator=${US})`,
        ...(before === undefined ? [] : [before]),
        "--",
      ]);
    } catch (error) {
      return { kind: "unreadable", detail: gitErrorText(error) };
    }
    const commits: AuditCommit[] = [];
    for (const block of out.split(RS)) {
      if (!block.trim()) continue;
      const lines = block.split("\n").filter((line) => line.length > 0);
      const [header, ...statusLines] = lines;
      const [hash, date, subject, ...trailerParts] = (header ?? "").split(US);
      if (!hash || !date) continue;
      const { files, renames } = parseNameStatus(statusLines);
      commits.push({
        hash,
        date,
        subject: subject ?? "",
        files,
        renames,
        actors: trailerParts.filter((value) => value.length > 0),
      });
    }
    if (before !== undefined && commits[0]?.hash.startsWith(before)) commits.shift();
    return { kind: "ok", commits: commits.slice(0, limit) };
  }

  function commitDiff(hash: string): CommitDiff {
    const h = assertCommitHash(hash);
    // `git show -M --pretty=format:` writes the unified diff for the commit
    // with NO commit header, so the output is exactly the concatenation of
    // per-file diff sections. `--first-parent` keeps the output sane on a
    // merge commit (the audit trail records linear curator/admin commits,
    // but be defensive). Section boundaries: each starts with `diff --git`.
    const text =
      tryGit([
        // Never C-quote a non-ASCII path (spec 064 SC 9b): the audit export keys a file's diff by
        // its path, so a C-quoted `"a/café.md"` header would miss the shelf filter and the diff
        // would be silently dropped — the same evasion `auditCommits`/`recentCommits` already close.
        "-c",
        "core.quotePath=false",
        "show",
        "-M",
        "--first-parent",
        "--pretty=format:",
        "--no-color",
        h,
      ]) ?? "";
    // Split on lines that start with `diff --git ` — keep the marker by
    // using a look-ahead so each section retains its header.
    const sections = text.split(/(?=^diff --git )/m).filter((s) => s.trim().length > 0);
    const files: CommitDiffFile[] = sections.map(parseDiffSection);
    return { hash: h, files };
  }

  function commitExists(hash: string): boolean {
    return tryGit(["cat-file", "-e", `${assertCommitHash(hash)}^{commit}`]) !== null;
  }

  function tag(name: string): void {
    // Tag names are server-generated (`pre-restore-<timestamp>`), but validate
    // anyway — argv discipline is cheap and uniform.
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
      throw new GitHashError(`'${name}' is not a usable tag name`);
    }
    git(["tag", name]);
  }

  function restoreTreeTo(hash: string): void {
    const target = assertCommitHash(hash);
    // `git restore --source` with the root pathspec makes index + worktree
    // match the target tree exactly: tracked files missing from the source are
    // REMOVED (the behaviour `checkout <hash> -- .` lacks). Staged only — the
    // caller commits the result as one new commit, so nothing is rewritten.
    git(["restore", `--source=${target}`, "--staged", "--worktree", "--", "."]);
  }

  return {
    fileHistory,
    fileAtCommit,
    fileDiff,
    recentCommits,
    auditCommits,
    commitDiff,
    commitExists,
    tag,
    restoreTreeTo,
  };
}

/** The stderr (or message) of a failed git call, for an `unreadable` audit-read detail. */
function gitErrorText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse `--name-status -M` rows into bare post-rename `files` (spec 064 SC 10) + rename pairs.
 * `M/A/D` rows are `X\tpath` → `parts[1]`; `R/C` rows are `R<score>\told\tnew` → `files` takes the
 * destination `parts[2]` (reproducing the pre-064 `--name-only` shape) and `renames` records both.
 */
function parseNameStatus(statusLines: string[]): {
  files: string[];
  renames: { from: string; to: string }[];
} {
  const files: string[] = [];
  const renames: { from: string; to: string }[] = [];
  for (const line of statusLines) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if ((status.startsWith("R") || status.startsWith("C")) && parts[1] && parts[2]) {
      files.push(parts[2]);
      renames.push({ from: parts[1], to: parts[2] });
    } else if (parts[1]) {
      files.push(parts[1]);
    }
  }
  return { files, renames };
}

/** The file's path after this commit, from its --name-status rows. */
function pathAtCommit(statusLines: string[]): string | null {
  for (const line of statusLines) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    // Rename/copy rows name old THEN new; everything else is `X\tpath`.
    if ((status.startsWith("R") || status.startsWith("C")) && parts[2]) return parts[2];
    if (parts[1]) return parts[1];
  }
  return null;
}

/** Parse one `diff --git a/from b/to` section into a structured CommitDiffFile.
 *  Status is derived from the section's metadata lines (`new file mode`,
 *  `deleted file mode`, `rename from/to`) rather than from `--name-status`,
 *  so it reflects the same data git's own diff already emitted. */
function parseDiffSection(section: string): CommitDiffFile {
  const headerMatch = section.split("\n", 1)[0]?.match(/^diff --git a\/(.+?) b\/(.+?)$/);
  const fromPath = headerMatch?.[1] ?? "";
  const toPath = headerMatch?.[2] ?? "";

  let status: CommitDiffFile["status"];
  if (/^new file mode /m.test(section)) {
    status = "added";
  } else if (/^deleted file mode /m.test(section)) {
    status = "deleted";
  } else if (fromPath !== toPath || /^rename (from|to) /m.test(section)) {
    status = "renamed";
  } else {
    status = "modified";
  }

  const path = status === "deleted" ? fromPath : toPath;
  return {
    path,
    status,
    ...(status === "renamed" && fromPath ? { fromPath } : {}),
    diff: section,
  };
}
