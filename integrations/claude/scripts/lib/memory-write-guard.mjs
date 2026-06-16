// Claude `PreToolUse` native-memory write-block — path classification (pure,
// testable). Spec 2026-06-16-harness-auto-capture, T4 (SC8); ADR 0009 layer 3.
//
// Node stdlib only (no deps). This module owns the ONE narrow decision the
// PreToolUse hook makes: is the file a Write/Edit/MultiEdit is about to touch the
// NATIVE Claude memory store? If so the hook blocks (exit 2) and redirects the
// agent to `remember`; otherwise it allows. Nothing here does IO — the thin hook
// entry (block-memory-write.mjs) reads stdin and acts on the verdict.
//
// SCOPE (ADR 0009, spec §4.8 — deliberately NARROW): block ONLY the native
// Claude memory store, the one competing memory channel:
//   - `**/.claude/**/memory/**`         (any file under a memory/ dir inside a
//                                        .claude/ store — incl. MEMORY.md)
// NOTHING broader. The prior draft's broad handoff-shaped / arbitrary-notes file
// veto was EXPLICITLY REJECTED (spec §3 "Out of scope", ADR 0009). So a project's
// own `src/memory.ts`, a top-level `MEMORY.md`, `docs/**`, `vault/primer.md`, and
// any `memory/` dir that is NOT under `.claude/` are all ALLOWED.
//
// FAIL-OPEN (spec §4.8): the classifier never throws. On any malformed/odd input
// it returns "not the native store" so the hook allows the write — a guard bug
// must never block a legitimate write.

/**
 * Split a file path into lowercased path segments, tolerant of both POSIX (`/`)
 * and Windows (`\`) separators and of a Windows drive prefix. Empty segments
 * (leading slash, doubled slash) are dropped. Pure + total: any non-string input
 * yields `[]`.
 *
 * @param {unknown} filePath
 * @returns {string[]} lowercased segments, in order.
 */
function segments(filePath) {
  if (typeof filePath !== "string" || !filePath) return [];
  return filePath
    .split(/[/\\]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "." && s !== "..");
}

/**
 * Is this path a write to the NATIVE Claude memory store (the one competing
 * channel the guard redirects to `remember`)? True iff the path contains a
 * `.claude` segment with a `memory` segment AFTER it — i.e. it lives inside a
 * `.../.claude/.../memory/...` store. The `memory` dir must be strictly deeper
 * than the `.claude` dir, so a `.claude/settings.json` or a project's own
 * `src/memory.ts` (no `.claude` ancestor) is NOT the store.
 *
 * Deliberately narrow (ADR 0009): only the native store, never broader. Pure +
 * total — never throws (fail-open is the caller's job; this just returns false on
 * anything it can't classify).
 *
 * @param {unknown} filePath - the target file path from the hook tool_input.
 * @returns {boolean} true ⇒ block; false ⇒ allow.
 */
export function isNativeMemoryWrite(filePath) {
  const segs = segments(filePath);
  if (segs.length === 0) return false;
  const claudeAt = segs.indexOf(".claude");
  if (claudeAt === -1) return false;
  // A `memory` segment must appear strictly AFTER the `.claude` segment AND
  // before the basename can be the memory store too (a file literally `memory`
  // is not a store; the store is a DIRECTORY named memory with content under it,
  // so the matched `memory` segment must not be the last segment).
  for (let i = claudeAt + 1; i < segs.length - 1; i += 1) {
    if (segs[i] === "memory") return true;
  }
  return false;
}

/**
 * Pull the target file path off a parsed PreToolUse hook payload. Claude puts the
 * write target on `tool_input.file_path` (Write / Edit / MultiEdit); we also
 * accept `tool_input.path` defensively. Returns the string path, or `null` when
 * there is no usable string path (→ the caller fails open / allows).
 *
 * @param {unknown} hook - the parsed hook JSON.
 * @returns {string|null}
 */
export function extractWritePath(hook) {
  if (!hook || typeof hook !== "object") return null;
  const toolInput = /** @type {Record<string, unknown>} */ (hook).tool_input;
  if (!toolInput || typeof toolInput !== "object") return null;
  const candidate =
    /** @type {Record<string, unknown>} */ (toolInput).file_path ??
    /** @type {Record<string, unknown>} */ (toolInput).path;
  return typeof candidate === "string" && candidate ? candidate : null;
}

/**
 * The teaching block message (AGENTS.md "errors teach"). Shown to the agent on a
 * blocked write (Claude surfaces a PreToolUse exit-2 stderr to the model). Names
 * the right channel (`remember`) and why, without leaking a stack trace.
 */
export const BLOCK_MESSAGE =
  "Blocked: this is Claude's native memory store. The Librarian is this " +
  "environment's memory — durable facts, preferences, and decisions belong there, " +
  "not in a local MEMORY.md the next session/agent/harness can't see. Call the " +
  "`remember` tool instead (fire-and-forget; the curator files it). If you must " +
  "keep a scratch note, write it somewhere outside the .claude/**/memory store.";

/**
 * The full guard verdict for a PreToolUse Write/Edit/MultiEdit. Returns
 * `{ block, message? }`. FAIL-OPEN: this never throws — any error classifying the
 * path resolves to `{ block: false }` (allow), because a guard bug must never
 * block a legitimate write (spec §4.8).
 *
 * @param {unknown} hook - the parsed hook JSON (tool_name + tool_input).
 * @returns {{block: boolean, message?: string}}
 */
export function evaluateMemoryWrite(hook) {
  try {
    const target = extractWritePath(hook);
    if (!target) return { block: false }; // no path → nothing to guard, allow
    if (isNativeMemoryWrite(target)) {
      return { block: true, message: BLOCK_MESSAGE };
    }
    return { block: false };
  } catch {
    // Fail-open: never let a guard bug block a write.
    return { block: false };
  }
}
