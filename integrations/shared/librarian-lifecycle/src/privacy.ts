// Privacy-marker detection (spec §3.1, §3.3).
//
// Pure, dependency-free phrase matching — no I/O, no remote calls. The
// shared helper and every harness hook run this *before* any Librarian
// call to decide whether the current prompt is off-record. Per §3.3 we
// use exact / near-exact phrase matching, never an aggressive semantic
// classifier: a false negative leaks nothing, but a false positive that
// trips on ordinary prose ("refactor the private fields") would silently
// stop recording legitimate work.

/** Default enter-private phrases (§3.3). */
export const DEFAULT_PRIVATE_MARKERS: readonly string[] = [
  "this is a private session",
  "don't remember this",
  "do not remember this",
  "don't save this",
  "do not save this",
  "don't store this",
  "off the record",
  "keep this between us",
  "private from here",
];

/** Default exit-private phrases (§3.3). */
export const DEFAULT_PUBLIC_MARKERS: readonly string[] = [
  "you can remember again",
  "end private mode",
  "back on the record",
  "this can be remembered",
];

/** The pure toggle command, in both the colon and hyphen renderings (§3.1). */
const TOGGLE_COMMANDS: readonly string[] = ["/lib-toggle-private", "/lib:toggle-private"];

export type PrivacySignal = "enter-private" | "exit-private" | "toggle" | "none";

export interface PrivacyMarkers {
  privateMarkers?: readonly string[];
  publicMarkers?: readonly string[];
}

export interface PrivacyDetection {
  signal: PrivacySignal;
  /** The marker/command phrase that matched, if any (for neutral logging). */
  matched?: string;
  /** Whether the prompt carries substantive content beyond the marker (§3.3). */
  hasSubstantiveContent: boolean;
}

// Lowercase and fold smart apostrophes to ASCII so "don’t remember this"
// matches the straight-quoted marker list.
function normalise(text: string): string {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").toLowerCase();
}

// Count alphanumeric characters left after the marker phrase is removed.
// Trailing punctuation ("off the record.") is not substantive; real
// content ("off the record, my key is …") is.
const SUBSTANTIVE_MIN_CHARS = 3;

function hasSubstantiveRemainder(normalisedPrompt: string, normalisedMarker: string): boolean {
  const idx = normalisedPrompt.indexOf(normalisedMarker);
  const without =
    idx === -1
      ? normalisedPrompt
      : `${normalisedPrompt.slice(0, idx)} ${normalisedPrompt.slice(idx + normalisedMarker.length)}`;
  const alnum = without.replace(/[^a-z0-9]+/g, "");
  return alnum.length >= SUBSTANTIVE_MIN_CHARS;
}

function firstMatch(normalisedPrompt: string, markers: readonly string[]): string | undefined {
  return markers.find((marker) => normalisedPrompt.includes(normalise(marker)));
}

/**
 * Classify a prompt's privacy intent. Private markers take precedence over
 * exit markers in the same prompt (fail toward privacy, §3.3). A pure
 * `/lib-toggle-private` command is reported as `toggle`; the same string
 * embedded in prose is not.
 */
export function detectPrivacySignal(
  prompt: string,
  markers: PrivacyMarkers = {},
): PrivacyDetection {
  const normalised = normalise(prompt);
  const trimmed = normalised.trim();

  if (TOGGLE_COMMANDS.includes(trimmed)) {
    return { signal: "toggle", matched: trimmed, hasSubstantiveContent: false };
  }

  const privateMarkers = markers.privateMarkers ?? DEFAULT_PRIVATE_MARKERS;
  const enter = firstMatch(normalised, privateMarkers);
  if (enter !== undefined) {
    return {
      signal: "enter-private",
      matched: enter,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(enter)),
    };
  }

  const publicMarkers = markers.publicMarkers ?? DEFAULT_PUBLIC_MARKERS;
  const exit = firstMatch(normalised, publicMarkers);
  if (exit !== undefined) {
    return {
      signal: "exit-private",
      matched: exit,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(exit)),
    };
  }

  return { signal: "none", hasSubstantiveContent: false };
}
