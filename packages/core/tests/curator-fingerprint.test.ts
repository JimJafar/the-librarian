// Curator content fingerprint + resurrection match (memory-curator spec §9.1 / §10.3).
//
// The deterministic pre-pass blocks resurrection of deliberately-archived
// memories: it computes a normalised content fingerprint (lowercased,
// whitespace-collapsed, punctuation-stripped → hashed) for each create/merge
// candidate and rejects any whose fingerprint OR normalised title matches an
// archived tombstone. These are the pure primitives behind that check.

import {
  type TombstoneRef,
  contentFingerprint,
  matchesTombstone,
  normalizeForFingerprint,
  normalizedTitle,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("normalizeForFingerprint", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeForFingerprint("  Hello,   World! ")).toBe("hello world");
  });

  it("treats case/punctuation/spacing variants as equal", () => {
    // Punctuation that sits next to a space collapses cleanly; this pins that
    // case + delimiter punctuation + extra spacing all fold to one form.
    expect(normalizeForFingerprint("The Plan:  Step 1!")).toBe(
      normalizeForFingerprint("the plan step 1"),
    );
  });

  it("keeps letters and digits across unicode", () => {
    expect(normalizeForFingerprint("Café 2026 — notes")).toBe("café 2026 notes");
  });

  it("keeps diacritics as distinguishing (NFKC, unlike the caller-id normaliser)", () => {
    expect(normalizeForFingerprint("café")).not.toBe(normalizeForFingerprint("cafe"));
  });

  it("normalises empty / whitespace-only / punctuation-only input to empty", () => {
    expect(normalizeForFingerprint("")).toBe("");
    expect(normalizeForFingerprint("   \t\n ")).toBe("");
    expect(normalizeForFingerprint("!!! … ---")).toBe("");
  });
});

describe("contentFingerprint", () => {
  it("is deterministic for the same input", () => {
    expect(contentFingerprint("Title", "Body")).toBe(contentFingerprint("Title", "Body"));
  });

  it("collapses normalisation-equivalent title+body to one fingerprint", () => {
    expect(contentFingerprint("Hello World", "Some body text")).toBe(
      contentFingerprint("hello,  world!", "some  body   text."),
    );
  });

  it("differs for different content", () => {
    expect(contentFingerprint("Title A", "Body")).not.toBe(contentFingerprint("Title B", "Body"));
  });

  it("does not collide title/body boundary (AB vs A+B split)", () => {
    // "ab"+"" must not hash the same as "a"+"b".
    expect(contentFingerprint("ab", "")).not.toBe(contentFingerprint("a", "b"));
  });
});

describe("matchesTombstone", () => {
  const tombstones: TombstoneRef[] = [
    {
      id: "mem_dead",
      content_fingerprint: contentFingerprint("Deprecated approach", "We tried X, it failed."),
      normalized_title: normalizedTitle("Deprecated approach"),
    },
  ];

  it("matches a resurrection by content fingerprint", () => {
    const hit = matchesTombstone(
      { title: "deprecated approach!", body: "we tried x, it failed" },
      tombstones,
    );
    expect(hit?.id).toBe("mem_dead");
  });

  it("matches a resurrection by normalised title alone (different body)", () => {
    const hit = matchesTombstone(
      { title: "Deprecated Approach", body: "totally different wording here" },
      tombstones,
    );
    expect(hit?.id).toBe("mem_dead");
  });

  it("returns null when neither fingerprint nor title matches", () => {
    const hit = matchesTombstone({ title: "A fresh idea", body: "new content" }, tombstones);
    expect(hit).toBeNull();
  });
});
