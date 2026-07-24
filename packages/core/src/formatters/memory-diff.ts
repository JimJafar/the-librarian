// Server-side old→new memory diff (spec 2026-06-20 proposal-review-ux, D3/T3).
//
// The dashboard's posture is "the server makes the diff, the client renders it"
// (DiffView, apps/dashboard/components/vault/diff-view.tsx). This is the server
// side of that contract for the proposal queue: given the memory a proposal
// supersedes and the proposed replacement, render a unified diff of their doc
// text that DiffView can colour.
//
// jsdiff v8 createTwoFilesPatch(oldName, newName, oldStr, newStr, oldHeader?,
// newHeader?, { context }) returns a unified-diff string PREFIXED with an
// `Index:` line and a `===` separator — neither of which DiffView classifies
// (it dims `---`/`+++`/`@@`/`diff `/`index `, not `Index:`/`===`). We strip
// that preamble so the returned string starts at the `--- `/`+++ `/`@@` headers
// DiffView dims. Source: Context7 /kpdecker/jsdiff README + llms.txt (2026-06-20).
import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";

// The minimal shape we diff — anything carrying a title + body (the store's
// closed `Memory`, the tRPC `MemoryShape`, or a plain fixture all satisfy it).
export interface DiffableMemory {
  title: string;
  body: string;
}

// The rendered doc text a memory presents — the same `# title` + body shape the
// markdown store persists, so the diff reads like the document, not a struct.
function renderDocText(memory: DiffableMemory): string {
  return `# ${memory.title}\n\n${memory.body}`;
}

/**
 * Fingerprint of a memory's reviewable content — spec 072 D1.
 *
 * Lives here, sharing `renderDocText` with the diff, so the two can never
 * disagree: whatever "the digest changed" reports, `unifiedMemoryDiff` can
 * always show. A proposal stamps one of these per superseded source at draft
 * time; review recomputes them to tell whether the corpus moved underneath it.
 *
 * Deliberately NOT a timestamp comparison: every persist bumps `updated_at`
 * (resolving a flag, archiving, a status change), so an `updated_at` check
 * would report drift when no content moved — and a safety gate that cries wolf
 * is one the operator learns to click through.
 */
export function memoryContentDigest(memory: DiffableMemory): string {
  return createHash("sha256").update(renderDocText(memory), "utf8").digest("hex");
}

/**
 * Unified diff of `oldMem` → `newMem` rendered doc text, in the format the
 * dashboard's DiffView consumes. Returns `""` when the two render identically.
 */
export function unifiedMemoryDiff(oldMem: DiffableMemory, newMem: DiffableMemory): string {
  const oldText = renderDocText(oldMem);
  const newText = renderDocText(newMem);

  // Identical docs produce a header-only patch with no hunks; report "no diff"
  // as an empty string so callers (and DiffView) treat it as "no changes".
  if (oldText === newText) return "";

  const patch = createTwoFilesPatch("current", "proposed", oldText, newText, "", "", {
    context: 3,
  });

  // Strip jsdiff's preamble: an optional `Index: …` line followed by the `===`
  // separator. Drop leading lines until we reach the first hunk header (`--- `,
  // `+++ `, or `@@`) DiffView actually classifies.
  const lines = patch.split("\n");
  const isHunkHeader = (line: string): boolean =>
    line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@");
  let start = 0;
  while (start < lines.length && !isHunkHeader(lines[start] ?? "")) {
    start++;
  }
  return lines.slice(start).join("\n");
}
