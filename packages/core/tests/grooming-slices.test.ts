// Candidate-slice enumeration for the curator scheduler (sessions-rethink §12):
// which slices have curatable content, drawn from memories (active/proposed).
// Memories are project-less, so grooming collapses to a SINGLE common_global
// slice — there is no per-project slicing left.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  createVaultGroomingMemorySource,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-slices-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

function mem(over: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return store!.createMemory(
    {
      agent_id: "agent-a",
      title: "t",
      body: "b",
      visibility: "common",
      priority: "normal",
      confidence: "working",
      ...over,
    },
    options,
  ).memory;
}

describe("listGroomingSlices", () => {
  it("returns nothing for an empty store", () => {
    expect(createVaultGroomingMemorySource(store!).listSlices()).toEqual([]);
  });

  it("returns the single global slice once any live memory exists", () => {
    mem({ title: "one" });
    mem({ title: "two" });

    const slices = createVaultGroomingMemorySource(store!).listSlices();
    expect(slices).toEqual([{ kind: "common_global" }]);
  });

  it("still emits exactly one global slice however many live memories exist", () => {
    mem({ title: "a" });
    mem({ title: "b" });
    mem({ title: "c" });
    expect(createVaultGroomingMemorySource(store!).listSlices()).toEqual([
      { kind: "common_global" },
    ]);
  });

  it("returns no slice when the only memory is archived", () => {
    const m = mem({ title: "dead" });
    store!.archiveMemory(m.id);
    expect(createVaultGroomingMemorySource(store!).listSlices()).toEqual([]);
  });
});
