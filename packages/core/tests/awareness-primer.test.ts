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
});
