// Per-session auto-capture state (Phase 2B / T-Pi) — the adapter's only durable
// capture state: a monotonic `seq` + the carried `private` span, keyed by Pi's
// getSessionId(). No byte offset (the turn arrives in-payload). Mirrors the
// Claude cursor / Hermes capture_state guarantees.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureStatePath,
  pruneOldState,
  readCaptureState,
  writeCaptureState,
} from "../extensions/librarian/capture-state.js";

/** Raw-write a state file (creating the capture/ dir), bypassing the atomic writer. */
function rawWriteState(dir: string, sessionId: string, contents: string): void {
  const p = captureStatePath(dir, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents, "utf8");
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-capture-state-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("readCaptureState (fail-soft fresh start)", () => {
  it("reads a fresh {seq:0, private:false} when no file exists", () => {
    expect(readCaptureState(dataDir, "sess-1")).toEqual({ seq: 0, private: false });
  });

  it("reads back what was written", () => {
    writeCaptureState(dataDir, "sess-1", { seq: 5, private: true });
    expect(readCaptureState(dataDir, "sess-1")).toEqual({ seq: 5, private: true });
  });

  it("reads fresh from a corrupt (non-JSON) file rather than throwing", () => {
    rawWriteState(dataDir, "sess-1", "{not json");
    expect(readCaptureState(dataDir, "sess-1")).toEqual({ seq: 0, private: false });
  });

  it("coerces a negative/non-integer seq to 0 and a non-true private to false", () => {
    rawWriteState(dataDir, "sess-1", JSON.stringify({ seq: -3, private: "yes" }));
    expect(readCaptureState(dataDir, "sess-1")).toEqual({ seq: 0, private: false });
  });
});

describe("writeCaptureState (atomic, fail-soft)", () => {
  it("persists across separate read calls", () => {
    writeCaptureState(dataDir, "sess-1", { seq: 1, private: false });
    writeCaptureState(dataDir, "sess-1", { seq: 2, private: true });
    expect(readCaptureState(dataDir, "sess-1")).toEqual({ seq: 2, private: true });
  });

  it("leaves no .tmp turds behind (atomic rename)", () => {
    writeCaptureState(dataDir, "sess-1", { seq: 1, private: false });
    // readdir the cursor dir: exactly one file, no .tmp
    const dir = captureStatePath(dataDir, "sess-1").replace(/\/[^/]+$/, "");
    const names = readdirSync(dir);
    expect(names.some((n) => n.includes(".tmp"))).toBe(false);
  });
});

describe("conv_id safety (path traversal defense)", () => {
  it("sanitizes a hostile id to a single safe segment (no parent escape)", () => {
    const p = captureStatePath(dataDir, "../../etc/passwd");
    // The file must stay inside dataDir's capture dir.
    expect(p.startsWith(dataDir)).toBe(true);
    expect(p).not.toContain("..");
    writeCaptureState(dataDir, "../../etc/passwd", { seq: 1, private: false });
    expect(readCaptureState(dataDir, "../../etc/passwd")).toEqual({ seq: 1, private: false });
  });

  it("distinct ids get distinct files (concurrent same-machine sessions don't collide)", () => {
    writeCaptureState(dataDir, "sess-a", { seq: 1, private: false });
    writeCaptureState(dataDir, "sess-b", { seq: 9, private: true });
    expect(readCaptureState(dataDir, "sess-a")).toEqual({ seq: 1, private: false });
    expect(readCaptureState(dataDir, "sess-b")).toEqual({ seq: 9, private: true });
  });
});

describe("pruneOldState (age-based, never clear-all)", () => {
  it("drops a state file older than the cutoff but keeps a fresh sibling", () => {
    writeCaptureState(dataDir, "old", { seq: 1, private: false });
    writeCaptureState(dataDir, "fresh", { seq: 2, private: false });
    // Backdate "old" past the cutoff.
    const old = captureStatePath(dataDir, "old");
    const past = Date.now() / 1000 - 10 * 24 * 60 * 60;
    utimesSync(old, past, past);

    pruneOldState(dataDir, 7 * 24 * 60 * 60 * 1000);

    expect(() => statSync(old)).toThrow(); // pruned
    expect(readCaptureState(dataDir, "fresh")).toEqual({ seq: 2, private: false }); // survives
  });

  it("is a fail-soft no-op when the capture dir does not exist", () => {
    expect(() => pruneOldState(join(dataDir, "nope"), 1000)).not.toThrow();
  });
});
