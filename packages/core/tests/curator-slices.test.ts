// Candidate-slice enumeration for the curator scheduler (sessions-rethink §12):
// which slices have curatable content, drawn from memories (active/proposed).
// Sessions no longer feed slice enumeration after the curator-decouple.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  createSqliteCuratorMemorySource,
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
      category: "lessons",
      visibility: "common",
      scope: "project",
      priority: "normal",
      confidence: "working",
      ...over,
    },
    options,
  ).memory;
}

describe("listCuratorSlices", () => {
  it("returns nothing for an empty store", () => {
    expect(createSqliteCuratorMemorySource(store!.db).listSlices()).toEqual([]);
  });

  it("enumerates the global slice and common projects from memories", () => {
    mem({ scope: "global", project_key: undefined });
    mem({ project_key: "proj-x" });
    mem({ project_key: "proj-y" });

    const slices = createSqliteCuratorMemorySource(store!.db).listSlices();
    expect(slices).toContainEqual({ kind: "common_global" });
    expect(slices).toContainEqual({ kind: "common_project", projectKey: "proj-x" });
    expect(slices).toContainEqual({ kind: "common_project", projectKey: "proj-y" });
  });

  it("excludes a project whose only memory is archived", () => {
    const m = mem({ project_key: "proj-dead" });
    store!.archiveMemory(m.id);
    const projects = createSqliteCuratorMemorySource(store!.db)
      .listSlices()
      .filter((s) => s.kind === "common_project");
    expect(projects).not.toContainEqual({ kind: "common_project", projectKey: "proj-dead" });
  });

  it("never enumerates agent_private slices after the sessions-rethink (no sources to derive them from)", () => {
    mem({ agent_id: "agent-a", project_key: undefined });
    mem({ agent_id: "agent-b", project_key: undefined });
    const agents = createSqliteCuratorMemorySource(store!.db)
      .listSlices()
      .filter((s) => s.kind === "agent_private");
    expect(agents).toHaveLength(0);
  });

  it("is deterministically ordered", () => {
    mem({ project_key: "proj-b" });
    mem({ project_key: "proj-a" });
    const projectKeys = createSqliteCuratorMemorySource(store!.db)
      .listSlices()
      .filter((s) => s.kind === "common_project")
      .map((s) => (s.kind === "common_project" ? s.projectKey : ""));
    expect(projectKeys).toEqual(["proj-a", "proj-b"]);
  });
});
