// The intake examples document (proposal-review rework 2026-07-01, F4 / D3).
//
// ONE curator-distilled document (`.curator/intake-examples.md`) holding
// examples of submissions the owner rejected hard enough to teach from — a
// SIBLING of the addendum (separate provenance, separate budget), same
// committed-vault-file mechanics. This pins:
//   - readIntakeExamples is fail-soft (missing file → "", null version);
//   - setIntakeExamples writes + commits, and REFUSES an over-cap doc with a
//     teaching error — the cap comes from the curator.intake.examples_max_bytes
//     setting, default 4096, measured in UTF-8 bytes;
//   - rollbackIntakeExamples restores the prior committed version as a new
//     commit (git is the undo trail), no-ops with restored:false when there is
//     no history, and never touches the addendum files.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXAMPLES_MAX_BYTES,
  EXAMPLES_MAX_BYTES_KEY,
  type LibrarianStore,
  createLibrarianStore,
  readExamplesMaxBytes,
  readIntakeExamples,
  setIntakeExamples,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-examples-"));
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

function vaultLog(dataDir: string): string[] {
  try {
    return execFileSync("git", ["log", "--format=%s"], {
      cwd: path.join(dataDir, "vault"),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("intake examples document (F4 / D3)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("reads empty + null version when the file does not exist (fail-soft)", () => {
    const { store } = s!;
    expect(readIntakeExamples(store)).toEqual({ content: "", version: null });
  });

  it("setIntakeExamples writes the file, commits it, and round-trips", () => {
    const { store, dataDir } = s!;
    setIntakeExamples(store, "- Rejected: one-off TODO notes.");

    const file = path.join(dataDir, "vault", ".curator", "intake-examples.md");
    expect(fs.readFileSync(file, "utf8")).toBe("- Rejected: one-off TODO notes.");

    const got = readIntakeExamples(store);
    expect(got.content).toBe("- Rejected: one-off TODO notes.");
    expect(got.version).toMatch(/^[0-9a-f]{40}$/);
    expect(vaultLog(dataDir).some((m) => /intake-examples/.test(m))).toBe(true);
  });

  it("refuses an over-cap document with a teaching error (default 4096 bytes)", () => {
    const { store } = s!;
    const over = "x".repeat(DEFAULT_EXAMPLES_MAX_BYTES + 1);
    expect(() => setIntakeExamples(store, over)).toThrow(/4096/);
    // Nothing was written.
    expect(readIntakeExamples(store).content).toBe("");
  });

  it("measures the cap in UTF-8 bytes, not characters", () => {
    const { store } = s!;
    // “é” is 2 bytes — 2100 of them exceed 4096 bytes at 2100 characters.
    const multibyte = "é".repeat(2100);
    expect(() => setIntakeExamples(store, multibyte)).toThrow(/bytes/);
  });

  it("honours the curator.intake.examples_max_bytes knob", () => {
    const { store } = s!;
    store.setSetting(EXAMPLES_MAX_BYTES_KEY, "64");
    expect(readExamplesMaxBytes(store)).toBe(64);
    expect(() => setIntakeExamples(store, "x".repeat(65))).toThrow(/64/);
    setIntakeExamples(store, "x".repeat(64)); // exactly at the cap is fine
    expect(readIntakeExamples(store).content).toBe("x".repeat(64));
  });

  it("falls back to the 4096 default for a missing or malformed knob", () => {
    const { store } = s!;
    expect(readExamplesMaxBytes(store)).toBe(DEFAULT_EXAMPLES_MAX_BYTES);
    store.setSetting(EXAMPLES_MAX_BYTES_KEY, "not-a-number");
    expect(readExamplesMaxBytes(store)).toBe(DEFAULT_EXAMPLES_MAX_BYTES);
  });

  it("rollbackIntakeExamples restores the prior version as a new commit", () => {
    const { store } = s!;
    setIntakeExamples(store, "version one");
    setIntakeExamples(store, "version two");

    const rollback = store.rollbackIntakeExamples();
    expect(rollback.restored).toBe(true);
    expect(readIntakeExamples(store).content).toBe("version one");
  });

  it("rollback with a single committed version restores to empty", () => {
    const { store } = s!;
    setIntakeExamples(store, "only version");
    const rollback = store.rollbackIntakeExamples();
    expect(rollback.restored).toBe(true);
    expect(readIntakeExamples(store).content).toBe("");
  });

  it("rollback with no history is a safe no-op", () => {
    const { store } = s!;
    expect(store.rollbackIntakeExamples()).toEqual({ restored: false, version: null });
  });

  it("is isolated from the addendum files (a sibling, not a job)", () => {
    const { store } = s!;
    setIntakeExamples(store, "examples doc");
    expect(store.readAddendum("intake").content).toBe("");
    store.writeAddendum("intake", "addendum doc");
    store.rollbackIntakeExamples();
    expect(store.readAddendum("intake").content).toBe("addendum doc");
  });
});
