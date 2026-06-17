// Codex auto-capture adapter — transcript parsing + filtering + conv_id
// derivation (pure, testable). Spec 2026-06-16-harness-auto-capture, Phase 2A.
//
// Node stdlib only (no deps; `node:crypto` is stdlib). Codex fires the SAME command-hook events as Claude
// (`UserPromptSubmit`/`Stop`/`SessionEnd`), so this module is the Claude
// transcript module (integrations/claude/scripts/lib/transcript.mjs) re-pointed
// at the Codex payload: the only Codex-specific pieces are (1) `harness:"codex"`
// on the delta and (2) `deriveConvId`, the graceful, NEVER-$USER/cwd conv_id
// chooser. Kept as a SEPARATE copy (not a shared import) because each integration
// ships as its own self-contained, dependency-free script tree.
//
// ── ASSUMED CODEX TRANSCRIPT + HOOK SHAPE (the one genuine unknown) ──────────
// There is no `codex` CLI on the build machine to confirm a live turn, so the
// shape below is DERIVED from mem0's PROVEN Codex hook scripts
// (/tmp/mem0-probe/integrations/mem0-plugin/scripts/{on_stop_cursor,on_user_prompt,
// on_session_start}.sh + install_codex_hooks.py) plus the Claude payload:
//   - The Codex hook stdin JSON carries `session_id`, `transcript_path`, `cwd`,
//     and `agent_id` — mem0 reads exactly these off the same hook input.
//   - The transcript at `transcript_path` is assumed to be append-only JSONL with
//     the same top-level `type` + `message.{role,content}` shape Claude uses; the
//     parser is FAIL-SOFT, so if Codex's real format differs, parseEntries simply
//     yields no turns (a clean no-op) rather than crashing — never a hook throw.
// This assumption is labelled here, in capture.mjs, in the hooks template, and in
// the adapter README. SC1 (a true e2e turn against a running Codex) is therefore
// DEFERRED/unverified; it is satisfied at the unit + contract level.

import { createHash } from "node:crypto";

/** The private-mode markers (AGENTS.md: never bypass private mode). */
export const PRIVATE_ON = "[librarian:private=on]";
export const PRIVATE_OFF = "[librarian:private=off]";

/** ASCII line feed — the JSONL record separator (one complete JSON object/line). */
const LF = 0x0a;

/**
 * Derive the stable conv_id for this Codex hook invocation. Capture keys ALL
 * per-conversation state (cursor, server buffer) by this id, so it MUST be stable
 * per conversation and MUST NOT collide across concurrent same-machine runs
 * (spec §4.11). The fallback chain degrades gracefully but NEVER reaches for
 * `$USER` or `cwd` — mem0's Codex scripts fall back to `/tmp/..._${USER}` /
 * `default_${USER}`, which is exactly the collision bug we avoid (two concurrent
 * Codex runs by one user, or two convs in one cwd, would share a conv_id and
 * cross-contaminate deltas).
 *
 * Chain:
 *   1. `session_id` — the hook's stable per-run id (preferred). mem0 confirms the
 *      Codex hook input carries `session_id`.
 *   2. `${stem}-${hash8}` — the transcript FILENAME stem (basename sans extension)
 *      combined with a short stable hash of the FULL normalized `transcript_path`.
 *      The hash is the discriminator: two concurrent runs whose transcript files
 *      share a basename in DIFFERENT directories (e.g. `…/projA/rollout.jsonl` and
 *      `…/projB/rollout.jsonl`) would otherwise BOTH derive `rollout` and collapse
 *      onto one cursor file AND one server buffer, cross-contaminating deltas (the
 *      exact SC5 collision). Folding the full path into the id keeps it stable per
 *      transcript yet distinct across dirs; the legible stem prefix keeps it
 *      debuggable rather than an opaque hash.
 *   3. null — caller fails soft to a clean no-op (NEVER cwd/$USER).
 *
 * @param {{session_id?:string, transcript_path?:string}} hook
 * @returns {string|null}
 */
export function deriveConvId(hook) {
  const sid = hook && typeof hook.session_id === "string" ? hook.session_id.trim() : "";
  if (sid) return sid;
  const tp = hook && typeof hook.transcript_path === "string" ? hook.transcript_path.trim() : "";
  if (tp) {
    // Basename without directory or extension. Forward AND back slashes so a
    // Windows-style path still reduces to a single segment.
    const base = tp.split(/[\\/]/).pop() || "";
    const stem = base.replace(/\.[^.]+$/, "");
    if (stem) {
      // Discriminate by the FULL path so two same-basename paths in different dirs
      // can't collapse. Short stable hash (8 hex of sha256), legible stem prefix.
      const hash8 = createHash("sha256").update(tp).digest("hex").slice(0, 8);
      return `${stem}-${hash8}`;
    }
  }
  // No stable id available — DO NOT key by cwd/$USER. The caller no-ops.
  return null;
}

/**
 * Find the byte offset just past the LAST complete line in a window Buffer (one
 * past the final `\n`). This is the precise, bounded boundary the cursor advances
 * to: everything before it is whole, parseable JSONL; a trailing partial line (a
 * hook firing mid-write) stays UNREAD until it completes. Operates on the BYTE
 * buffer so the count is a true byte offset under UTF-8 multibyte. Returns 0 when
 * the window holds no `\n`.
 *
 * @param {Buffer} buf
 * @returns {number}
 */
export function completeLineBytes(buf) {
  if (!buf || buf.length === 0) return 0;
  const lastLf = buf.lastIndexOf(LF);
  return lastLf === -1 ? 0 : lastLf + 1;
}

/**
 * Parse a chunk of append-only JSONL into entry objects. Forward-only + fail-soft:
 * a blank or partially-written trailing line is silently skipped, never thrown
 * (we get it next run once complete).
 *
 * @param {string} chunk
 * @returns {Array<Record<string, unknown>>}
 */
export function parseEntries(chunk) {
  const entries = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Partial/last line mid-write, or corrupt — skip; it completes next run.
    }
  }
  return entries;
}

/**
 * Flatten an assistant content array to its prose, dropping `thinking`,
 * `tool_use`, and any non-text block (machine plumbing / private reasoning, not
 * durable conversational fact).
 */
function assistantText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Extract real user prose. A string is the prompt; an array is tool plumbing. */
function userText(content) {
  if (typeof content === "string") return content.trim();
  return "";
}

/**
 * Map parsed JSONL entries to user/assistant turns, ignoring anything that is not
 * a top-level conversational message (non-message types, sidechain/subagent
 * entries, meta entries, empty-after-extraction turns).
 *
 * @returns {Array<{role:"user"|"assistant", text:string, ts?:string}>}
 */
export function entriesToTurns(entries) {
  const turns = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.isSidechain === true) continue;
    if (e.isMeta === true) continue;
    const type = e.type;
    if (type !== "user" && type !== "assistant") continue;
    const message = e.message;
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = role === "user" ? userText(message.content) : assistantText(message.content);
    if (!text) continue;

    const turn = { role, text };
    if (typeof e.timestamp === "string") turn.ts = e.timestamp;
    turns.push(turn);
  }
  return turns;
}

/**
 * Per-turn private-span filter. Tracks the `[private=on]/[private=off]` marker
 * state across turns AND across runs (via `startPrivate`). Any turn while the span
 * is open is SKIPPED; the marker-toggle turns are skipped too. Forward-only: the
 * caller advances the cursor past skipped turns so a private turn is NEVER
 * retroactively shipped. Within one turn the LAST-occurring marker wins.
 *
 * @param {Array<{role:string,text:string,ts?:string}>} turns
 * @param {{startPrivate:boolean}} opts
 * @returns {{kept:Array, endPrivate:boolean}}
 */
export function filterPrivateSpans(turns, { startPrivate }) {
  let priv = Boolean(startPrivate);
  const kept = [];
  for (const turn of turns) {
    const text = turn.text;
    const hasOn = text.includes(PRIVATE_ON);
    const hasOff = text.includes(PRIVATE_OFF);
    const isMarkerTurn = hasOn || hasOff;

    if (hasOn || hasOff) {
      const onAt = hasOn ? text.lastIndexOf(PRIVATE_ON) : -1;
      const offAt = hasOff ? text.lastIndexOf(PRIVATE_OFF) : -1;
      priv = onAt > offAt;
    }

    if (priv || isMarkerTurn) continue;
    kept.push(turn);
  }
  return { kept, endPrivate: priv };
}

/**
 * Build the uniform, harness-agnostic delta payload the server contract expects:
 * `{ conv_id, harness:"codex", seq, turns[], ended? }`. `ended` is omitted unless
 * true (the server treats its mere presence as the explicit-end accelerator).
 */
export function buildPayload({ convId, seq, turns, ended }) {
  /** @type {Record<string, unknown>} */
  const payload = {
    conv_id: convId,
    harness: "codex",
    seq,
    turns,
  };
  if (ended) payload.ended = true;
  return payload;
}
