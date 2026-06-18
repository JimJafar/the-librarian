// Portable extraction of a single integration subtree out of a GitHub
// codeload tarball.
//
// The harness capture adapters (Codex / OpenCode / Hermes) don't ship inside
// their plugin packages — the installer downloads the pinned release tarball
// from codeload and copies one `integrations/<harness>/…` subtree out of it.
//
// History: the original approach selected members directly with
//   tar -xzf t -C out --strip-components=N --wildcards '*/integrations/<h>/*'
// That is GNU-tar-only. BSD/libarchive tar (the `/usr/bin/tar` on macOS)
// rejects the flag outright — `tar: Option --wildcards is not supported` —
// and busybox tar lacks it too, so the Codex/OpenCode/Hermes steps failed on
// every non-GNU box. (GNU tar needs `--wildcards` to glob member names on
// extract; BSD tar globs by default and has no such flag — there is no single
// flag set that means "glob members" on both.)
//
// Fix: extract the whole archive using only the universally-supported
// `-xzf`/`-C` flags, then locate the wanted subtree with the filesystem. No
// `--wildcards`, no `--strip-components`, no tar-flavour detection.

import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";

/**
 * Extract `subPath` (a POSIX path *inside* the repo root, e.g.
 * `integrations/codex`) out of a codeload `.tar.gz` and return the absolute
 * path to it. The returned directory's CONTENTS are the subtree's contents —
 * matching the old `--strip-components` semantics, so callers copy from the
 * returned path unchanged.
 *
 * @param tarball  path to the downloaded `.tar.gz`
 * @param work     scratch dir to extract into (caller owns its lifecycle)
 * @param subPath  POSIX subtree path inside the repo root, e.g. `integrations/codex`
 * @throws if tar exits non-zero, the tarball layout is unexpected, or the
 *         requested subtree is absent — with a message safe to show the user.
 */
export async function extractAdapterSubtree(
  tarball: string,
  work: string,
  subPath: string,
): Promise<string> {
  const raw = path.join(work, "raw");
  fs.mkdirSync(raw, { recursive: true });

  // Only `-xzf`/`-C` — supported by GNU tar, BSD/libarchive tar, and busybox.
  const extract = await run("tar", ["-xzf", tarball, "-C", raw]);
  if (extract.code !== 0) {
    throw new Error((extract.stderr || "").trim() || `tar exited with code ${extract.code}`);
  }

  // codeload wraps everything in a single top-level dir whose name depends on
  // the ref (GitHub strips a leading `v` from tags: `v1.2.3` → `…-1.2.3`), so
  // discover it rather than hardcode it.
  const tops = fs.readdirSync(raw).filter((e) => !e.startsWith("."));
  const top = tops.length === 1 ? tops[0] : tops.find((e) => e.startsWith("the-librarian-"));
  if (!top) {
    throw new Error(`unexpected tarball layout (top-level entries: ${tops.join(", ") || "none"})`);
  }

  const dir = path.join(raw, top, ...subPath.split("/"));
  if (!fs.existsSync(dir)) {
    throw new Error(`adapter path '${subPath}' not found under '${top}' in tarball`);
  }
  return dir;
}
