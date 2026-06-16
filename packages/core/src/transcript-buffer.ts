// Transcript sidecar buffer — the path + naming contract shared by BOTH halves
// of automatic capture (spec 2026-06-16-harness-auto-capture):
//
//   - INGESTION (T1, packages/mcp-server transcript-intake): the POST /transcript
//     endpoint appends redacted turns to `<dataDir>/transcripts/<conv_id>.md` and,
//     on an explicit `ended:true`, drops an `<conv_id>.ended` marker.
//   - EXTRACTION (T2, transcript-sweep here in core): the settle-sweep reads those
//     buffers, claims each atomically to `<conv_id>.processing`, extracts, deletes.
//
// These helpers live in @librarian/core so the two halves can NEVER drift on the
// path or the sanitisation (the T1 module re-exports them). The buffer lives
// OUTSIDE the git vault, sibling to vault/ — `data/` is gitignored (SC6).

import path from "node:path";

/** The sidecar buffer dir, under the data dir, OUTSIDE the git vault. */
export const TRANSCRIPTS_DIR = "transcripts";

/**
 * Sanitize a caller-supplied `conv_id` into a single safe filename segment so it
 * can never path-traverse out of `transcripts/` (SC6). We keep only
 * `[A-Za-z0-9._-]`, replacing every other char (including `/`, `\`, and the NUL
 * byte) with `_`, then strip leading dots so `..` / `.` can't escape or resolve
 * to the dir itself. The result is non-empty; a pathological all-illegal id
 * collapses to a stable `_`-only token, which is safe — at worst two such ids
 * share a buffer, never a traversal.
 */
export function sanitizeConvId(convId: string): string {
  const cleaned = convId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "_";
}

/** The transcripts sidecar dir: `<data-dir>/transcripts/`. */
export function transcriptsDir(dataDir: string): string {
  return path.join(dataDir, TRANSCRIPTS_DIR);
}

/** Where a conversation's buffer lives: `<data-dir>/transcripts/<safe-conv_id>.md`. */
export function transcriptBufferPath(dataDir: string, convId: string): string {
  return path.join(transcriptsDir(dataDir), `${sanitizeConvId(convId)}.md`);
}

/**
 * The atomic-claim path the sweep renames a buffer to before extracting:
 * `<data-dir>/transcripts/<safe-conv_id>.processing`. A `.processing` rename
 * means the next T1 POST for that conv_id starts a FRESH `<conv_id>.md` (T1
 * appends to the `.md`), so a straggler delta never races the delete.
 */
export function transcriptProcessingPath(dataDir: string, convId: string): string {
  return path.join(transcriptsDir(dataDir), `${sanitizeConvId(convId)}.processing`);
}

/**
 * The explicit-end marker T1 drops beside the buffer when a delta carries
 * `ended:true`: `<data-dir>/transcripts/<safe-conv_id>.ended`. Its presence
 * accelerates settle (the sweep treats the buffer as settled regardless of
 * idle/size); it is deleted with the buffer after extraction. A marker without a
 * buffer is harmless and reaped by the sweep.
 */
export function endedMarkerPath(dataDir: string, convId: string): string {
  return path.join(transcriptsDir(dataDir), `${sanitizeConvId(convId)}.ended`);
}
