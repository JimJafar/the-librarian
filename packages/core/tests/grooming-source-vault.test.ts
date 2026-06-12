// Vault-backed GroomingMemorySource (plan 036 Phase 4). Pins the slice
// partition semantics (project-key-only, rethink D8): exact project_key for
// common_project, project_key IS NULL for common_global; active/proposed feed
// slices + evidence, archived feed tombstones (no body, archiveReason null).

import { type Memory, createVaultGroomingMemorySource } from "@librarian/core";
import { describe, expect, it } from "vitest";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    agent_id: "agent-a",
    title: "t",
    body: "b",
    status: "active",
    project_key: null,
    priority: "normal",
    confidence: "working",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    recall_count: 0,
    usefulness_score: 0,
    is_global: false,
    requires_approval: false,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

/** A source over a fixed in-memory memory list (mirrors the markdown store's listAll). */
function sourceOf(memories: Memory[]) {
  return createVaultGroomingMemorySource({ listAll: () => memories });
}

describe("createVaultGroomingMemorySource — listSlices", () => {
  it("enumerates the global slice and common projects from active/proposed memories", () => {
    const source = sourceOf([
      mem({ id: "g", project_key: null }),
      mem({ id: "x", project_key: "proj-x" }),
      mem({ id: "y", project_key: "proj-y", status: "proposed", requires_approval: true }),
    ]);
    const slices = source.listSlices();
    expect(slices).toContainEqual({ kind: "common_global" });
    expect(slices).toContainEqual({ kind: "common_project", projectKey: "proj-x" });
    expect(slices).toContainEqual({ kind: "common_project", projectKey: "proj-y" });
  });

  it("excludes a project whose only memory is archived", () => {
    const source = sourceOf([mem({ id: "dead", project_key: "proj-dead", status: "archived" })]);
    expect(source.listSlices()).toEqual([]);
  });

  it("omits the global slice when every project-less memory is archived", () => {
    const source = sourceOf([
      mem({ id: "g", project_key: null, status: "archived" }),
      mem({ id: "x", project_key: "proj-x" }),
    ]);
    const slices = source.listSlices();
    expect(slices).not.toContainEqual({ kind: "common_global" });
    expect(slices).toContainEqual({ kind: "common_project", projectKey: "proj-x" });
  });

  it("orders common projects deterministically", () => {
    const source = sourceOf([
      mem({ id: "1", project_key: "proj-b" }),
      mem({ id: "2", project_key: "proj-a" }),
    ]);
    expect(
      source
        .listSlices()
        .filter((s) => s.kind === "common_project")
        .map((s) => s.projectKey),
    ).toEqual(["proj-a", "proj-b"]);
  });
});

describe("createVaultGroomingMemorySource — selectMemories (slice isolation)", () => {
  it("common_project returns only that project's memories (exact match, no global bleed)", () => {
    const source = sourceOf([
      mem({ id: "here", project_key: "proj-x" }),
      mem({ id: "other", project_key: "proj-y" }),
      mem({ id: "global", project_key: null }),
    ]);
    expect(
      source
        .selectMemories({ kind: "common_project", projectKey: "proj-x" }, "active", 50)
        .map((m) => m.id),
    ).toEqual(["here"]);
  });

  it("common_global returns only project-less memories", () => {
    const source = sourceOf([
      mem({ id: "global", project_key: null }),
      mem({ id: "keyed", project_key: "proj-x" }),
    ]);
    const ids = source.selectMemories({ kind: "common_global" }, "active", 50).map((m) => m.id);
    expect(ids).toContain("global");
    expect(ids).not.toContain("keyed");
  });

  it("partitions active vs proposed", () => {
    const source = sourceOf([
      mem({ id: "active-one", project_key: "proj-x" }),
      mem({ id: "proposed-one", project_key: "proj-x", status: "proposed" }),
    ]);
    const slice = { kind: "common_project" as const, projectKey: "proj-x" };
    expect(source.selectMemories(slice, "active", 50).map((m) => m.id)).toEqual(["active-one"]);
    expect(source.selectMemories(slice, "proposed", 50).map((m) => m.id)).toEqual(["proposed-one"]);
  });

  it("orders newest-first and respects the limit", () => {
    const source = sourceOf([
      mem({ id: "old", project_key: "proj-x", updated_at: "2026-06-01T00:00:00.000Z" }),
      mem({ id: "new", project_key: "proj-x", updated_at: "2026-06-03T00:00:00.000Z" }),
      mem({ id: "mid", project_key: "proj-x", updated_at: "2026-06-02T00:00:00.000Z" }),
    ]);
    const slice = { kind: "common_project" as const, projectKey: "proj-x" };
    expect(source.selectMemories(slice, "active", 50).map((m) => m.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(source.selectMemories(slice, "active", 2).map((m) => m.id)).toEqual(["new", "mid"]);
  });

  it("maps the verdict booleans onto the record", () => {
    const source = sourceOf([
      mem({ id: "p", project_key: "proj-x", requires_approval: true, is_global: true }),
    ]);
    const [rec] = source.selectMemories(
      { kind: "common_project", projectKey: "proj-x" },
      "active",
      50,
    );
    expect(rec?.requiresApproval).toBe(true);
    expect(rec?.isGlobal).toBe(true);
  });
});

describe("createVaultGroomingMemorySource — selectTombstones", () => {
  it("returns archived memories with archivedAt=updated_at, a null reason, and the raw body for fingerprinting", () => {
    const source = sourceOf([
      mem({
        id: "dead",
        project_key: "proj-x",
        status: "archived",
        title: "deleted thing",
        body: "the original body",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
      mem({ id: "live", project_key: "proj-x" }),
    ]);
    const tombs = source.selectTombstones({ kind: "common_project", projectKey: "proj-x" }, 50);
    expect(tombs.map((t) => t.id)).toEqual(["dead"]);
    expect(tombs[0]?.archivedAt).toBe("2026-06-05T00:00:00.000Z");
    expect(tombs[0]?.archiveReason).toBeNull();
    // The raw body is carried on the record (gatherMemoryEvidence fingerprints
    // it then drops it); it must be present here so the resurrection key is real.
    expect(tombs[0]?.body).toBe("the original body");
  });
});
