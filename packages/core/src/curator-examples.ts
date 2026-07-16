// The intake examples document (proposal-review rework 2026-07-01, F4 / D3).
//
// ONE curator-distilled document holding examples of submissions the owner
// rejected hard enough to be made an example of ("Reject & make an example",
// D5) — so the same class of extraction stops recurring. A SIBLING of the
// per-job addendum (spec 044): same committed-vault-file mechanics
// (`.curator/intake-examples.md`, git history is the version trail, rollback
// is a new revertable commit), but separate provenance — the ADDENDUM is
// operator-authored steering; the EXAMPLES doc is curator-distilled teaching
// material, written only through the explicit teach flow — and a separate
// budget: its byte cap is the `curator.intake.examples_max_bytes` setting
// (default 4096), not the addendum's hard 2 KB constant.
//
// The whole document rides the intake prompt when non-empty (D7 — no
// retrieval machinery); see curator-prompt.ts. The file read/write/rollback
// primitives live on the store layer (it owns the vault + git committer);
// these helpers add the cap policy, mirroring curator-addendum.ts.

import type { SettingsStore } from "./store/settings-store.js";

/** The examples doc content + its git version (same record shape as the addendum). */
export interface IntakeExamples {
  /** The document text (empty string when the file is absent — fail-soft). */
  content: string;
  /** The commit hash that last touched the file, or null when it has no history. */
  version: string | null;
}

/** The store slice the examples helpers need. */
export interface ExamplesStore extends SettingsStore {
  readIntakeExamples: () => IntakeExamples;
  writeIntakeExamples: (content: string, actorId?: string) => IntakeExamples;
}

/** The byte-cap knob (settings key). Bytes, not characters. */
export const EXAMPLES_MAX_BYTES_KEY = "curator.intake.examples_max_bytes";

/** Default cap: 4 KB — double the addendum's, it holds distilled examples. */
export const DEFAULT_EXAMPLES_MAX_BYTES = 4096;

/**
 * The current byte cap for the examples document: the
 * `curator.intake.examples_max_bytes` setting, falling back to 4096 when the
 * setting is absent or not a positive integer.
 */
export function readExamplesMaxBytes(store: SettingsStore): number {
  const raw = store.getSetting(EXAMPLES_MAX_BYTES_KEY);
  if (raw === null) return DEFAULT_EXAMPLES_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_EXAMPLES_MAX_BYTES;
  return parsed;
}

/**
 * Read the intake examples document from its committed vault file. Fail-soft:
 * a missing file returns `{ content: "", version: null }` — the fresh-install
 * default, and the intake prompt then carries no examples block.
 */
export function readIntakeExamples(store: ExamplesStore): IntakeExamples {
  return store.readIntakeExamples();
}

/**
 * Write the intake examples document AND commit it. Enforces the byte cap at
 * this trust boundary (mirrors setJobAddendum): an over-cap document is
 * REFUSED before any write/commit, with a teaching error naming the cap — the
 * distill flow's whole-document rewrite sits in front of this backstop.
 */
export function setIntakeExamples(
  store: ExamplesStore,
  content: string,
  actorId?: string,
): IntakeExamples {
  const cap = readExamplesMaxBytes(store);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > cap) {
    throw new Error(
      `intake examples document must be ≤ ${cap} bytes (curator.intake.examples_max_bytes); got ${bytes} bytes`,
    );
  }
  return store.writeIntakeExamples(content, actorId);
}
