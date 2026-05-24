// Curator content fingerprints + resurrection detection (memory-curator spec §9.1 / §10.3).
//
// Archived memories are passed to the curator's LLM as metadata-only tombstones
// — never their full body — plus a `content_fingerprint`: a hash of the
// normalised title+body. The deterministic pre-pass computes the same
// fingerprint for each create/merge candidate and blocks any whose fingerprint
// OR normalised title matches a tombstone, so deliberately-deleted content is
// neither re-exposed to the model nor resurrected. This catches exact and
// near-exact (normalisation-equivalent) resurrection cheaply; paraphrase-level
// detection is a v2 concern.
//
// Server-only (the curator runs server-side) — safe to depend on node:crypto.

import { createHash } from "node:crypto";
import { redactSecrets } from "./curator-redaction.js";

/**
 * Collapse free-form content to a comparison form: NFKC, lowercased,
 * punctuation stripped (anything that isn't a letter, number, or whitespace),
 * whitespace collapsed to single spaces, trimmed.
 *
 * Deliberately NFKC (not the NFKD + combining-mark strip used by the caller-id
 * normaliser): diacritics are KEPT, so `café` ≠ `cafe`. Stripping them would
 * over-merge distinct content and widen resurrection suppression. Note that
 * empty / punctuation-only input normalises to "" — callers (evidence gathering)
 * should not build tombstones from empty-normalising memories, or every
 * empty-normalising candidate would match them.
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The normalised title alone — a tombstone also matches on this (§10.3). */
export function normalizedTitle(title: string): string {
  return normalizeForFingerprint(title);
}

/**
 * Stable hash of the normalised title+body. Title and body are joined with a
 * newline, which the normaliser never emits (whitespace is collapsed to single
 * spaces), so the boundary is unambiguous — `("ab","")` can't collide with
 * `("a","b")`.
 */
export function contentFingerprint(title: string, body: string): string {
  const normalised = `${normalizeForFingerprint(title)}\n${normalizeForFingerprint(body)}`;
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/**
 * The curation fingerprint CONTRACT: redact secrets, THEN fingerprint. Both
 * tombstone gathering (§9.1) and the candidate pre-pass (§10.3) must compute
 * keys through this pair, so a secret-bearing memory can't slip the resurrection
 * guard via a raw-vs-redacted fingerprint mismatch. `redactSecrets` is idempotent
 * (markers are not re-matched), so passing already-redacted text is a safe no-op.
 */
export function curationContentFingerprint(title: string, body: string): string {
  return contentFingerprint(redactSecrets(title).redacted, redactSecrets(body).redacted);
}

/** Redact-then-normalise the title — the curation-side secondary resurrection key. */
export function curationNormalizedTitle(title: string): string {
  return normalizedTitle(redactSecrets(title).redacted);
}

// The fingerprint of empty-normalising content (sha256 of "\n"). Content that
// normalises to this carries no identity — it must never match a tombstone, or
// every title-less / punctuation-only memory would resurrection-match.
const EMPTY_CONTENT_FINGERPRINT = contentFingerprint("", "");

/** Metadata-only reference to an archived memory, as carried in evidence (§9.1). */
export interface TombstoneRef {
  id: string;
  content_fingerprint: string;
  normalized_title: string;
}

/**
 * Return the first tombstone a candidate would resurrect — matching either its
 * content fingerprint or its normalised title — or null if none. The caller
 * (deterministic pre-pass) suppresses create/merge candidates that match.
 *
 * Candidate keys are computed through the redact-then-fingerprint contract
 * (`curationContentFingerprint`/`curationNormalizedTitle`), matching how
 * tombstone keys are built during evidence gathering — otherwise a secret-bearing
 * memory would mismatch and escape the guard. An empty normalised title is never
 * treated as a title hit, so an empty-normalising tombstone can't super-match.
 */
export function matchesTombstone(
  candidate: { title: string; body: string },
  tombstones: Iterable<TombstoneRef>,
): TombstoneRef | null {
  const fingerprint = curationContentFingerprint(candidate.title, candidate.body);
  const title = curationNormalizedTitle(candidate.title);
  // Neither key matches on empty-normalising content (both arms guard it), so a
  // title-less / punctuation-only memory never resurrection-matches.
  const fingerprintMeaningful = fingerprint !== EMPTY_CONTENT_FINGERPRINT;
  for (const tombstone of tombstones) {
    if (fingerprintMeaningful && tombstone.content_fingerprint === fingerprint) return tombstone;
    if (title !== "" && tombstone.normalized_title === title) return tombstone;
  }
  return null;
}
