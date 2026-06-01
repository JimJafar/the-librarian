// CurationStore curator-read methods (F0 — seal the seam).
//
// The curator read functions (gatherMemoryEvidence / listCuratorSlices /
// selectDueSlices / findRunningRun) are pure functions over the SQLite db.
// To stop non-storage code (curator-worker, curator-enqueue) from reaching
// `store.db`, the store exposes thin wrappers that bind its own db. This pins
// that the wrappers delegate to exactly those functions with the store's db.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type EvidenceSlice,
  createLibrarianStore,
  findRunningRun,
  gatherMemoryEvidence,
  listCuratorSlices,
  selectDueSlices,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Inferred (not the public `LibrarianStore`) so this storage-layer test keeps
// access to `db` after the F0 public/internal interface split (PR-6).
let store: ReturnType<typeof createLibrarianStore> | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-curation-reads-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

describe("CurationStore — curator read methods bind the store db", () => {
  it("delegates the curator read functions to the underlying store db", () => {
    const s = store!;
    const slice: EvidenceSlice = { kind: "common_global" };
    const schedule = { intervalMinutes: 60 };
    const now = new Date("2026-06-01T00:00:00.000Z");

    expect(s.listCuratorSlices()).toEqual(listCuratorSlices(s.db));
    expect(s.gatherMemoryEvidence(slice, { maxMemories: 5 })).toEqual(
      gatherMemoryEvidence(s.db, slice, { maxMemories: 5 }),
    );
    expect(s.selectDueSlices(schedule, now)).toEqual(selectDueSlices(s.db, schedule, now));
    expect(s.findRunningRun(slice)).toEqual(findRunningRun(s.db, slice));
  });
});
