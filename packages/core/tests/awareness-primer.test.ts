// Awareness primer setting (spec 041 PR-1 / Task A1).
//
// The primer is a server-sourced note injected every harness turn (A2 wires the
// read into `conv_state_get`). A1 lands the setting, its shipped default, and the
// fail-soft read helper. Semantics under test:
//   - key NULL (never set) → the SHIPPED DEFAULT (works out-of-the-box);
//   - key "" (explicitly)  → DISABLED (reads back "");
//   - custom string        → round-trips verbatim;
//   - store throws         → "" (FAIL-SOFT; this read fires every turn, never blocks it).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AWARENESS_PRIMER_KEY,
  DEFAULT_AWARENESS_PRIMER,
  type LibrarianStore,
  WORKING_STYLE_KEY,
  createLibrarianStore,
  readAwarenessPrimer,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-primer-"));
  return { store: createLibrarianStore({ dataDir }), dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

describe("awareness primer setting (spec 041 A1)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("reads back the shipped default when the setting was never written", () => {
    expect(s!.store.getSetting(AWARENESS_PRIMER_KEY)).toBeNull();
    expect(readAwarenessPrimer(s!.store)).toBe(DEFAULT_AWARENESS_PRIMER);
  });

  it("the shipped default matches spec 041 Decision 3 verbatim", () => {
    expect(DEFAULT_AWARENESS_PRIMER).toBe(
      "You have The Librarian: durable, cross-session memory. " +
        "Use `recall` to check what's already known before asking; " +
        "use `remember` / `/learn` to save durable facts, preferences, and decisions worth keeping.",
    );
  });

  it("an explicit empty string DISABLES the primer (reads back '')", () => {
    s!.store.setSetting(AWARENESS_PRIMER_KEY, "");
    expect(readAwarenessPrimer(s!.store)).toBe("");
  });

  it("a custom primer round-trips verbatim", () => {
    const custom = "You have memory. Use recall first.";
    s!.store.setSetting(AWARENESS_PRIMER_KEY, custom);
    expect(readAwarenessPrimer(s!.store)).toBe(custom);
  });

  it("is fail-soft: an unreadable settings store yields '' and never throws", () => {
    const broken: Pick<typeof s.store, "getSetting"> = {
      getSetting() {
        throw new Error("settings store is locked");
      },
    };
    expect(() => readAwarenessPrimer(broken)).not.toThrow();
    expect(readAwarenessPrimer(broken)).toBe("");
  });

  // The working-style preamble (formerly carried by the retired `session_manifest`
  // tool) is now folded into the standing primer so it rides the per-turn injection
  // channel `conv_state_get` already uses — ADR 0006.
  it("appends the working_style preamble to the primer when it is set", () => {
    s!.store.setSetting(WORKING_STYLE_KEY, "Be concise. Prefer bullet points.");
    const primer = readAwarenessPrimer(s!.store);
    expect(primer).toContain(DEFAULT_AWARENESS_PRIMER);
    expect(primer).toContain("Be concise. Prefer bullet points.");
    // working-style trails the awareness note (the standing note comes first).
    expect(primer.indexOf("Be concise")).toBeGreaterThan(primer.indexOf(DEFAULT_AWARENESS_PRIMER));
  });

  it("leaves the primer untouched when working_style is unset", () => {
    expect(s!.store.getSetting(WORKING_STYLE_KEY)).toBeNull();
    expect(readAwarenessPrimer(s!.store)).toBe(DEFAULT_AWARENESS_PRIMER);
  });

  it("leaves the primer untouched when working_style is empty", () => {
    s!.store.setSetting(WORKING_STYLE_KEY, "");
    expect(readAwarenessPrimer(s!.store)).toBe(DEFAULT_AWARENESS_PRIMER);
  });

  it("delivers working_style even when the awareness note is disabled", () => {
    s!.store.setSetting(AWARENESS_PRIMER_KEY, "");
    s!.store.setSetting(WORKING_STYLE_KEY, "Always answer in French.");
    expect(readAwarenessPrimer(s!.store)).toBe("Always answer in French.");
  });

  it("is fail-soft on the working_style read: a throw degrades to the awareness note alone", () => {
    const onlyAwareness: Pick<typeof s.store, "getSetting"> = {
      getSetting(key: string) {
        if (key === WORKING_STYLE_KEY) throw new Error("secret-stored, no master key");
        return null;
      },
    };
    expect(() => readAwarenessPrimer(onlyAwareness)).not.toThrow();
    expect(readAwarenessPrimer(onlyAwareness)).toBe(DEFAULT_AWARENESS_PRIMER);
  });
});
