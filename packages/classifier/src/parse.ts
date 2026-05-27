// Output parser — extracts the verdict from the model's raw text.
//
// Contract (spec §4.5):
//   1. Trim to the last `{ ... }` block in the output (the model may
//      emit a chain-of-thought preamble; we want the last JSON object).
//   2. `JSON.parse` and validate against `ClassifierVerdictSchema`
//      (exactly two boolean keys, no extras).
//   3. Either return a clean verdict or null. Callers map null to the
//      `fallback_used: "parse"` path.

import { ClassifierVerdictSchema, type ClassifierVerdict } from "./types.js";

/**
 * Parse the model's raw text into a verdict, or null on any failure.
 *
 * Failure modes folded to null: no `{...}` block; malformed JSON; missing
 * keys; extra keys; wrong types. The caller has no use for the failure
 * reason beyond "did it parse?" — the fallback flag is uniformly `"parse"`.
 */
export function parseVerdict(text: string): ClassifierVerdict | null {
  const last = lastJsonObject(text);
  if (last === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return null;
  }
  const result = ClassifierVerdictSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Slice out the last balanced `{...}` from `text`. Walks the string
 * right-to-left tracking brace depth; ignores braces inside strings.
 *
 * Returns the slice (including the outermost braces) or null when
 * there's no balanced block. The "balanced" check matters when a model
 * emits incomplete JSON during chain-of-thought — we only want a block
 * we can actually parse.
 */
function lastJsonObject(text: string): string | null {
  // Walk left-to-right and remember the most recent BALANCED top-level
  // object's start+end. Cheaper than reversing the string and avoids
  // JSON-inside-strings false positives because we track string state.
  let depth = 0;
  let inString = false;
  let escape = false;
  let topStart = -1;
  let lastStart = -1;
  let lastEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === 0x5c /* \ */) {
        escape = true;
      } else if (ch === 0x22 /* " */) {
        inString = false;
      }
      continue;
    }
    if (ch === 0x22 /* " */) {
      inString = true;
      continue;
    }
    if (ch === 0x7b /* { */) {
      if (depth === 0) topStart = i;
      depth++;
      continue;
    }
    if (ch === 0x7d /* } */) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && topStart >= 0) {
        lastStart = topStart;
        lastEnd = i;
        topStart = -1;
      }
      continue;
    }
  }
  if (lastStart < 0 || lastEnd < 0) return null;
  return text.slice(lastStart, lastEnd + 1);
}
