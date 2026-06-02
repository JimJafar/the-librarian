// Consolidator — minimal-edit transforms (spec 035 §F5, gaps G5/S18). The
// consolidator must NEVER rewrite a hand-authored doc: augmenting one ADDS the
// new information and leaves the existing prose intact. These are pure string
// transforms over a memory body; the store wiring (read target → augment →
// write, with this as the guard) is a separate increment.
//
// The judge already emits [[wikilinks]] inside the addition, so these transforms
// are link-agnostic — they only own the append + the no-clobber guarantee.

/**
 * Minimal-edit augmentation: weave `addition` into `existing` by APPENDING it as
 * a new paragraph, never rewriting the existing prose. The original content
 * survives verbatim (it remains a prefix of the result) — the no-clobber
 * guarantee (G5/S18). Only outer/trailing whitespace is normalised. An empty
 * addition leaves the doc unchanged; an empty doc becomes just the addition.
 */
export function augmentBody(existing: string, addition: string): string {
  const add = addition.trim();
  if (!add) return existing;
  const base = existing.trimEnd();
  if (!base.trim()) return add;
  return `${base}\n\n${add}`;
}

/**
 * No-clobber backstop (G5, the "git diff is the backstop" check in code): true
 * iff every non-empty line of `before` still appears in `after`. `augmentBody`
 * satisfies it by construction; the apply layer uses it to REJECT any edit that
 * would drop hand-authored content (e.g. a supersede the model over-rewrote).
 */
export function preservesOriginal(before: string, after: string): boolean {
  return before
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .every((line) => after.includes(line));
}
